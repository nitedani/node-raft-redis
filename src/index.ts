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
}
interface Message {
  type: "vote" | "request";
  from: string;
  to?: string;
  granted?: boolean;
  currentTerm: number;
}

type State = "candidate" | "leader" | "follower";

export class Candidate extends EventEmitter {
  kind: string = "";
  redisClient: RedisClientType;
  subscriptionClient: RedisClientType | null = null;
  nodeId = randomString();

  state: State = "follower";
  currentTerm = 1;
  votedFor = "";

  votes = 0;
  timeout: NodeJS.Timeout | null = null;
  leadershipInterval: NodeJS.Timer | null = null;
  countNodesInterval: NodeJS.Timer | null = null;
  stopCheckInterval: NodeJS.Timer | null = null;
  startCheckInterval: NodeJS.Timer | null = null;

  running = false;
  connected = false;

  constructor(options: Options) {
    super();
    const { redis, kind } = options;
    this.kind = kind || "";
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

  private async getNodeCount() {
    await this.redisClient.set(
      `consensus-nodes:${this.kind}:${this.nodeId}`,
      Date.now()
    );
    const keys = await this.redisClient.keys(`consensus-nodes:${this.kind}:*`);

    const alive = [];
    const dead = [];
    for (const key of keys) {
      const val = await this.redisClient.get(key);
      if (val && Date.now() - parseInt(val, 10) > 5000) {
        dead.push(key);
      } else {
        alive.push(key);
      }
    }

    if (dead.length) {
      await this.redisClient.del(dead);
    }

    return alive.length;
  }

  async startTimeout() {
    if (this.timeout) {
      clearTimeout(this.timeout);
    }
    this.timeout = setTimeout(() => {
      this.state = "candidate";
      this.votedFor = this.nodeId;
      this.votes = 1;
      this.currentTerm++;
      const message: Message = {
        type: "request",
        from: this.nodeId,
        currentTerm: this.currentTerm,
      };

      this.redisClient.publish(
        `consensus-events:${this.kind}`,
        JSON.stringify(message)
      );
      this.startTimeout();
    }, randomTimeout());
  }

  private startLeadership() {
    if (this.timeout) {
      clearTimeout(this.timeout);
    }
    this.setState("leader");

    const _message: Message = {
      type: "request",
      from: this.nodeId,
      currentTerm: this.currentTerm,
    };
    this.redisClient.publish(
      `consensus-events:${this.kind}`,
      JSON.stringify(_message)
    );
    if (this.leadershipInterval) {
      clearTimeout(this.leadershipInterval);
    }
    this.leadershipInterval = setInterval(() => {
      this.redisClient.publish(
        `consensus-events:${this.kind}`,
        JSON.stringify(_message)
      );
    }, 750);
  }

  private setState(state: State) {
    if (this.state !== state) {
      if (state === "leader") {
        this.emit("elected");
      }
      if (this.state === "leader") {
        this.emit("defeated");
      }
      this.state = state;
      this.emit("statechange", state);
    }
  }

  private async _stop() {
    try {
      if (this.timeout) {
        clearTimeout(this.timeout);
      }
      if (this.leadershipInterval) {
        clearTimeout(this.leadershipInterval);
      }
      if (this.countNodesInterval) {
        clearTimeout(this.countNodesInterval);
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

  private async _start() {
    this.running = true;
    await this.redisClient.connect();
    await new Promise((r) => setTimeout(r, randomTimeout()));
    let count = await this.getNodeCount();
    this.countNodesInterval = setInterval(async () => {
      count = await this.getNodeCount();
      if (count === 1 && this.state !== "leader") {
        this.startLeadership();
      }
    }, 2500);

    this.subscriptionClient = this.redisClient.duplicate();
    this.subscriptionClient.on("error", (err) => {
      this.emit("error", err);
    });

    this.subscriptionClient.subscribe(
      `consensus-events:${this.kind}`,
      (str) => {
        const message = JSON.parse(str) as Message;
        if (message.from === this.nodeId) {
          return;
        }
        if (message.type === "request") {
          if (
            this.currentTerm < message.currentTerm ||
            (this.state === "follower" &&
              this.currentTerm <= message.currentTerm &&
              this.votedFor === message.from)
          ) {
            this.setState("follower");
            this.currentTerm = message.currentTerm;
            this.votedFor = message.from;

            const reply: Message = {
              type: "vote",
              from: this.nodeId,
              to: message.from,
              granted: true,
              currentTerm: this.currentTerm,
            };
            this.redisClient.publish(
              `consensus-events:${this.kind}`,
              JSON.stringify(reply)
            );
            this.startTimeout();
          } else {
            const reply: Message = {
              type: "vote",
              from: this.nodeId,
              to: message.from,
              granted: false,
              currentTerm: this.currentTerm,
            };
            this.redisClient.publish(
              `consensus-events:${this.kind}`,
              JSON.stringify(reply)
            );
          }
        } else {
          if (
            this.state === "candidate" &&
            message.to === this.nodeId &&
            message.granted &&
            message.currentTerm === this.currentTerm
          ) {
            this.votes++;
            if (this.votes >= Math.floor(count / 2) + 1) {
              this.startLeadership();
            }
          }
        }
      }
    );

    await this.subscriptionClient.connect();

    this.startTimeout();
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
    this.startCheckInterval = setInterval(() => {
      if (
        !this.redisClient.isOpen &&
        !this.subscriptionClient?.isOpen &&
        !this.running
      ) {
        if (this.startCheckInterval) {
          clearInterval(this.startCheckInterval);
        }
        this._start();
      }
    }, 100);
  }

  async stop() {
    return new Promise<void>((resolve) => {
      if (this.startCheckInterval) {
        clearInterval(this.startCheckInterval);
        if (!this.running) {
          return;
        }
      }
      if (this.stopCheckInterval) {
        clearInterval(this.stopCheckInterval);
      }
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

  async stepdown() {
    if (this.state === "leader") {
      if (this.leadershipInterval) {
        clearInterval(this.leadershipInterval);
      }

      this.setState("follower");
      this.votes = 0;
      this.votedFor = "";
      this.nodeId = randomString();

      this.startTimeout();
    }
  }
}
export default Candidate;
