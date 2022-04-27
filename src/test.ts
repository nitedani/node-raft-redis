import { Candidate } from "./index";

const candidate = new Candidate({
  redis: {
    host: "localhost",
    port: 6379,
    // or url: 'redis://alice:foobared@awesome.redis.server:6380'
  },
  kind: "my-service",
});

candidate.on("elected", () => {
  console.log("elected");
  // You can be sure only this instance is the leader.

  // The leader can start a re-election with stepdown()
  // It is possible for this instance to be elected again.
  // candidate.stepdown();
});

candidate.on("error", (err) => {
  console.error(err);
});

candidate.start();

/*
Candidate.stop() will stop the candidate's internal processes and
disconnects from redis.
It will result in a re-election.

// candidate.stop()
*/
