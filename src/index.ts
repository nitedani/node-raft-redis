import { createClient, RedisClientType } from "redis";
import { EventEmitter } from "events";
import cuid from "cuid";

const randomTimeout = () => {
  const min = 200;
  const max = 300;
  return Math.floor(Math.random() * (max - min + 1)) + min;
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
  nodeId = cuid();

  state: State = "follower";
  currentTerm = 1;
  votedFor = "";

  votes = 0;
  timeout: NodeJS.Timeout | null = null;
  leadershipTimeout: NodeJS.Timeout | null = null;

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
  }

  private async getNodeCount() {
    await this.redisClient.set(
      `consensus-nodes:${this.kind}:${this.nodeId}`,
      Date.now()
    );
    const keys = await this.redisClient.keys(`consensus-nodes:${this.kind}:*`);
    let count = 0;
    for (const key of keys) {
      // val is a timestamp
      const val = await this.redisClient.get(key);
      // if val is older than 2 seconds, delete it
      if (val && Date.now() - parseInt(val, 10) > 2000) {
        await this.redisClient.del(key);
      } else {
        count++;
      }
    }
    return count;
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
    this.state = "leader";
    const _message: Message = {
      type: "request",
      from: this.nodeId,
      currentTerm: this.currentTerm,
    };
    this.redisClient.publish(
      `consensus-events:${this.kind}`,
      JSON.stringify(_message)
    );
    this.emit("elected");
    if (this.leadershipTimeout) {
      clearTimeout(this.leadershipTimeout);
    }
    this.leadershipTimeout = setInterval(() => {
      this.redisClient.publish(
        `consensus-events:${this.kind}`,
        JSON.stringify(_message)
      );
    }, 150);
  }

  async run() {
    await this.redisClient.connect();
    await new Promise((r) => setTimeout(r, 2000));
    let count = await this.getNodeCount();
    setInterval(async () => {
      count = await this.getNodeCount();
      if (count === 1 && this.state !== "leader") {
        this.startLeadership();
      }
    }, 500);

    const subscriber = this.redisClient.duplicate();

    subscriber.subscribe(`consensus-events:${this.kind}`, (str) => {
      const message = JSON.parse(str) as Message;
      if (message.from === this.nodeId) {
        return;
      }
      if (message.type === "request") {
        if (
          this.currentTerm <= message.currentTerm ||
          this.state === "follower"
        ) {
          this.state = "follower";
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
          if (this.votes >= count / 2 + 1) {
            this.startLeadership();
          }
        }
      }
    });

    await subscriber.connect();

    this.startTimeout();
  }
}
export default Candidate;
