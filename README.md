Consensus for node microservices, based on a simplified verison of the [raft algorithm](https://raft.github.io/). Requires redis as a medium.

Features automatic discovery of the services of same kind.
Selects one instance of a microservice as leader. 

For example, the leader can push jobs to a redis queue while the followers process them.

---
Usage: <br>

```tsx
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


```

Methods:

- start: connects to redis, starts the candidate's internal processes
- stop: disconnects from redis, stops the candidate's internal processes
- stepdown: if the candidate is the leader, starts a re-election

Events:

- elected: when the candidate is elected as the leader
- defeated: when the candidate steps down from being the leader
- error: redis connection error