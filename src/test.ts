import { Candidate } from "./index";

const candidate = new Candidate({
  redis: {
    host: "localhost",
    port: 6379,
    // or url: 'redis://alice:foobared@awesome.redis.server:6380'
  },
  kind: "my-service",
  meta: {
    someKey: Math.random(),
  },
});

candidate.on("elected", async () => {
  console.log("elected");
  // You can be sure only this instance is the leader (at this moment).
  candidate.messageFollowers("Hello from leader");

  // The leader can start a re-election with reelect()
  // It is possible for this instance to be elected again.
  //candidate.reelect();
});

candidate.on("message", async ({ message, from }) => {
  const currentLeader = await candidate.getLeader();
  const isFromLeader = from === currentLeader?.id;

  if (isFromLeader) {
    candidate.messageTo(from, "Echo from follower");
  }
});

candidate.on("message:from:follower", ({ message, from }) => {
  // Will be logged only in the leader instance.
  // console.log(message, from);
});

candidate.on("error", (err) => {
  console.error(err);
});

candidate.start();
