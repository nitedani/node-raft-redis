import { createClient, RedisClientType } from "redis";
import { EventEmitter } from "events";

const randomTimeout = () => {
  const min = 1000;
  const max = 1500;
  return Math.floor(Math.random() * (max - min + 1)) + min;
};

const randomString = () => {
  return (
    Math.random().toString(36).substring(2, 15) +
    Math.random().toString(36).substring(2, 15)
  );
};
export interface Options {
  redis: {
    host?: string;
    port?: number;
    url?: string;
  };
  kind?: string;
  meta?: any;
}

export type State = "candidate" | "leader" | "follower";

export interface Instance {
  id: string;
  state: State;
  meta: any;
}

interface Message {
  type: "vote" | "request" | "check";
  from: string;
  to?: string;
  granted?: boolean;
  currentTerm: number;
  ignore?: string[];
}

export class Candidate extends EventEmitter {
  private kind = "";
  private __meta = {};
  private running = false;
  private __instanceId = randomString();
  private redisClient: RedisClientType;
  private subscriptionClient: RedisClientType | null = null;

  private leaderSubscription = false;
  private followerSubscription = false;
  private privateSubsciption = false;

  private votes = new Set<string>();
  private votedFor = "";
  private __currentTerm = 1;
  private __state: State = "follower";

  private timeout: NodeJS.Timeout | null = null;
  private requestInterval: NodeJS.Timer | null = null;
  private leadershipInterval: NodeJS.Timer | null = null;
  private countNodesInterval: NodeJS.Timer | null = null;
  private stopCheckInterval: NodeJS.Timer | null = null;
  private startCheckInterval: NodeJS.Timer | null = null;

  constructor(options: Options) {
    super();
    const { redis, kind, meta } = options;
    this.kind = kind || "";
    this.__meta = meta || "";
    if (redis.url) {
      this.redisClient = createClient({ url: redis.url });
    } else {
      this.redisClient = createClient({
        socket: {
          host: redis.host,
          port: redis.port,
        },
      });
    }
    this.redisClient.on("error", (err) => {
      this.emit("error", err);
    });
  }

  private keepAlive() {
    return this.redisClient.set(
      `consensus-nodes:${this.kind}:${this.__instanceId}`,
      JSON.stringify({ ts: Date.now(), meta: this.__meta, state: this.__state })
    );
  }

  private async getInstanceCount() {
    return this.getInstances().then((instances) => instances.length);
  }

  async getInstances() {
    const keys = await this.redisClient.keys(`consensus-nodes:${this.kind}:*`);

    const alive = [];
    const dead = [];

    for (const key of keys) {
      const val = await this.redisClient.get(key);
      if (!val) {
        dead.push(key);
        continue;
      }

      const { ts, meta, state } = JSON.parse(val);
      if (Date.now() - parseInt(ts, 10) > 2000) {
        dead.push(key);
      } else {
        const instanceId = key.split(":")[2];
        const instance: Instance = {
          id: instanceId,
          meta,
          state,
        };

        alive.push(instance);
      }
    }

    if (dead.length) {
      await this.redisClient.del(dead);
    }

    return alive;
  }

  async startTimeout() {
    this.votes = new Set();

    if (this.timeout) {
      clearInterval(this.timeout);
    }
    if (this.leadershipInterval) {
      clearInterval(this.leadershipInterval);
    }

    if (this.requestInterval) {
      clearInterval(this.requestInterval);
      this.requestInterval = null;
    }

    this.timeout = setInterval(() => {
      this.setState("candidate");

      this.__currentTerm++;
      this.votedFor = this.__instanceId;
      this.votes.add(this.__instanceId);

      const sendRequest = () => {
        const message: Message = {
          type: "request",
          from: this.__instanceId,
          currentTerm: this.__currentTerm,
          ignore: [...this.votes],
        };

        this.redisClient.publish(
          `consensus-events:${this.kind}`,
          JSON.stringify(message)
        );
      };

      this.requestInterval ??= setInterval(() => {
        sendRequest();
      }, 400);

      sendRequest();
    }, randomTimeout());
  }

  private startLeadership() {
    if (this.timeout) {
      clearInterval(this.timeout);
    }
    if (this.leadershipInterval) {
      clearInterval(this.leadershipInterval);
    }
    if (this.requestInterval) {
      clearInterval(this.requestInterval);
    }

    const _message: Message = {
      type: "check",
      from: this.__instanceId,
      currentTerm: this.__currentTerm,
    };
    this.redisClient.publish(
      `consensus-events:${this.kind}`,
      JSON.stringify(_message)
    );
    this.leadershipInterval = setInterval(() => {
      this.redisClient.publish(
        `consensus-events:${this.kind}`,
        JSON.stringify(_message)
      );
    }, 400);
    this.setState("leader");
  }

  private setState(state: State, initiator?: string) {
    if (state !== "leader") {
      if (this.leadershipInterval) {
        clearInterval(this.leadershipInterval);
      }
    }
    if (state !== "candidate") {
      this.emit("__init");
    }
    if (this.__state !== state) {
      this.__state = state;
      this.keepAlive();

      if (state === "leader") {
        this.subscribeLeaderChannel();
        this.emit("elected");
      } else {
        this.unsubscribeLeaderChannel();
      }

      if (state === "follower") {
        this.subscribeFollowerChannel();
        this.emit("defeated", initiator);
      } else {
        this.unsubscribeFollowerChannel();
      }

      this.emit("statechange", state);
    }
  }

  private async _stop() {
    try {
      if (this.timeout) {
        clearInterval(this.timeout);
      }
      if (this.leadershipInterval) {
        clearInterval(this.leadershipInterval);
      }
      if (this.countNodesInterval) {
        clearInterval(this.countNodesInterval);
      }
      if (this.subscriptionClient?.isOpen) {
        await this.subscriptionClient.unsubscribe();
        await this.subscriptionClient.quit();
      }
      if (this.redisClient?.isOpen) {
        await this.redisClient.quit();
      }
      this.running = false;
    } catch (error) {
      this.emit("error", error);
    }
  }

  private async subscribePrivateChannel() {
    if (this.privateSubsciption) {
      return;
    }
    this.privateSubsciption = true;
    await this.subscriptionClient?.subscribe(
      `consensus-messages:${this.kind}:${this.__instanceId}`,
      (str) => {
        const { message, from } = JSON.parse(str);
        if (from !== this.__instanceId) {
          this.emit("message", { message, from });
          if (this.state === "leader") {
            this.emit("message:from:follower", { message, from });
          }
          if (this.votedFor === from) {
            this.emit("message:from:leader", { message, from });
          }
        }
      }
    );
  }

  private async unsubscribePrivateChannel() {
    await this.subscriptionClient?.unsubscribe(
      `consensus-messages:${this.kind}:${this.__instanceId}`
    );
    this.privateSubsciption = false;
  }

  private async subscribeFollowerChannel() {
    if (this.followerSubscription) {
      return;
    }
    this.followerSubscription = true;
    await this.subscriptionClient?.subscribe(
      `consensus-messages:${this.kind}:followers`,
      (str) => {
        const { message, from } = JSON.parse(str);
        if (this.__state === "follower" && from !== this.__instanceId) {
          this.emit("message", { message, from });
          if (this.votedFor === from) {
            this.emit("message:from:leader", { message, from });
          }
        }
      }
    );
  }

  private async unsubscribeFollowerChannel() {
    await this.subscriptionClient?.unsubscribe(
      `consensus-messages:${this.kind}:followers`
    );
    this.followerSubscription = false;
  }

  private async subscribeLeaderChannel() {
    if (this.leaderSubscription) {
      return;
    }
    this.leaderSubscription = true;
    await this.subscriptionClient?.subscribe(
      `consensus-messages:${this.kind}:leader`,
      (str) => {
        const { message, from } = JSON.parse(str);
        if (this.__state === "leader" && from !== this.__instanceId) {
          this.emit("message", { message, from });
          this.emit("message:from:follower", { message, from });
        }
      }
    );
  }

  private async unsubscribeLeaderChannel() {
    await this.subscriptionClient?.unsubscribe(
      `consensus-messages:${this.kind}:leader`
    );
    this.leaderSubscription = false;
  }

  private async _start() {
    this.running = true;
    await this.redisClient.connect();
    await new Promise((r) => setTimeout(r, randomTimeout()));
    await this.keepAlive();
    await new Promise((r) => setTimeout(r, 1000));
    await this.keepAlive();
    let count = await this.getInstanceCount();
    this.countNodesInterval = setInterval(async () => {
      await this.keepAlive();
      count = await this.getInstanceCount();

      if (count === 1 && this.__state !== "leader") {
        this.startLeadership();
      }
    }, 1000);

    this.subscriptionClient = this.redisClient.duplicate();
    this.subscriptionClient.on("error", (err) => {
      this.emit("error", err);
    });

    this.subscribeFollowerChannel();
    this.subscribePrivateChannel();

    this.subscriptionClient.subscribe(
      `consensus-messages:${this.kind}`,
      (str) => {
        const { message, from } = JSON.parse(str);
        if (from !== this.__instanceId) {
          this.emit("message", { message, from });
        }
      }
    );

    this.subscriptionClient.subscribe(
      `consensus-events:${this.kind}`,
      (str) => {
        const message = JSON.parse(str) as Message;
        if (
          message.from === this.__instanceId ||
          message.ignore?.includes(this.__instanceId)
        ) {
          return;
        }
        if (message.type === "request" || message.type === "check") {
          if (
            this.__currentTerm < message.currentTerm ||
            (message.type === "check" &&
              this.__currentTerm <= message.currentTerm)
          ) {
            if (this.leadershipInterval) {
              clearInterval(this.leadershipInterval);
            }
            this.__currentTerm = message.currentTerm;
            this.votedFor = message.from;
            this.setState("follower", message.from);

            const reply: Message = {
              type: "vote",
              from: this.__instanceId,
              to: message.from,
              granted: true,
              currentTerm: this.__currentTerm,
            };
            this.redisClient.publish(
              `consensus-events:${this.kind}`,
              JSON.stringify(reply)
            );

            this.startTimeout();
          } else {
            const reply: Message = {
              type: "vote",
              from: this.__instanceId,
              to: message.from,
              granted: false,
              currentTerm: this.__currentTerm,
            };
            this.redisClient.publish(
              `consensus-events:${this.kind}`,
              JSON.stringify(reply)
            );
          }
        } else {
          if (
            this.__state === "candidate" &&
            message.to === this.__instanceId &&
            message.granted &&
            message.currentTerm === this.__currentTerm
          ) {
            this.votes.add(message.from);

            if (this.votes.size >= Math.floor(count / 2) + 1) {
              this.startLeadership();
            }
          }
        }
      }
    );

    await this.subscriptionClient.connect();

    this.startTimeout();

    await new Promise((resolve) => {
      this.once("__init", resolve);
    });
  }

  async start() {
    if (this.startCheckInterval) {
      clearInterval(this.startCheckInterval);
    }
    if (this.stopCheckInterval) {
      clearInterval(this.stopCheckInterval);
    }
    if (this.running) {
      return;
    }
    return new Promise<void>((resolve) => {
      this.startCheckInterval = setInterval(async () => {
        if (
          !this.redisClient.isOpen &&
          !this.subscriptionClient?.isOpen &&
          !this.running
        ) {
          if (this.startCheckInterval) {
            clearInterval(this.startCheckInterval);
          }
          await this._start();
          resolve();
        }
      }, 100);
    });
  }

  async stop() {
    if (this.startCheckInterval) {
      clearInterval(this.startCheckInterval);
      if (!this.running) {
        return;
      }
    }
    if (this.stopCheckInterval) {
      clearInterval(this.stopCheckInterval);
    }
    return new Promise<void>((resolve) => {
      this.stopCheckInterval = setInterval(async () => {
        if (this.redisClient.isOpen && this.subscriptionClient?.isOpen) {
          if (this.stopCheckInterval) {
            clearInterval(this.stopCheckInterval);
          }
          await this._stop();
          resolve();
        }
      }, 100);
    });
  }

  async reelect() {
    if (this.__state === "leader") {
      this.votedFor = "";
      this.startTimeout();
    }
  }

  stepdown() {
    return this.reelect();
  }

  async messageFollowers(message: string) {
    await this.redisClient.publish(
      `consensus-messages:${this.kind}:followers`,
      JSON.stringify({ message, from: this.__instanceId })
    );
  }

  async messageTo(to: string, message: string) {
    await this.redisClient.publish(
      `consensus-messages:${this.kind}:${to}`,
      JSON.stringify({ message, from: this.__instanceId })
    );
  }

  async messageAll(message: string) {
    await this.redisClient.publish(
      `consensus-messages:${this.kind}`,
      JSON.stringify({ message, from: this.__instanceId })
    );
  }

  async messageLeader(message: string) {
    await this.redisClient.publish(
      `consensus-messages:${this.kind}:leader`,
      JSON.stringify({ message, from: this.__instanceId })
    );
  }

  get currentTerm() {
    return this.__currentTerm;
  }

  get id() {
    return this.__instanceId;
  }

  get state() {
    return this.__state;
  }

  async getLeader() {
    const instances = await this.getInstances();
    return instances.find((instance) => instance.state === "leader");
  }

  async setMeta(meta: any) {
    this.__meta = meta;
    await this.keepAlive();
  }

  get meta() {
    return this.__meta;
  }
}
export default Candidate;
