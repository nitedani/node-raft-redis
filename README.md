Consensus for node microservices, based on a simplified version of the [raft algorithm](https://raft.github.io/). Requires redis as a medium.
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
  // You can be sure only this instance is the leader (at the moment).

  candidate.messageFollowers("Hello from leader");

  // The leader can start a re-election with reelect()
  // It is possible for this instance to be elected again. In that case, "elected" will be emitted again.
  // candidate.reelect();
});

candidate.on("defeated", (leader) => {
  console.log(`defeated by the new leader ${leader}`)
  candidate.messageLeader("Hello from your new follower")
});

candidate.on("message", ({ message, from }) => {
  console.log(`Got message ${message} from ${from}`)
});

candidate.on("error", (err) => {
  console.error(err);
});

candidate.start();


```


Examples:


```tsx

const candidate = new Candidate({
  redis: {
    host: "localhost",
    port: 6379,
  },
  kind: "my-service",
  meta: {
    // Set some metadata for this instance
    someKey: Math.random(),
  },
});

await candidate.start();
// Get all instances of this kind, including self
const instances = await candidate.getInstances()
/*
[
  {
    id: 'rqcpc6g0ncgi3mxtysyv1',
    meta: { someKey: 0.8191968688804481 },
    state: 'follower'
  },
  {
    id: 'ga4empryhsch6mi5zlemgn',
    meta: { someKey: 0.5482506611623577 },
    state: 'follower'
  },
  {
    id: 'qtualcg9ncgq62eruoqe18',
    meta: { someKey: 0.6551732192131019 },  
    state: 'leader'
  },
  {
    id: 'aow8uegf3241mt95pqhte3',
    meta: { someKey: 0.7014849186816583 },  
    state: 'follower'
  }
]
*/

// Send a message to an instance
candidate.messageTo('rqcpc6g0ncgi3mxtysyv1', "Hello")

// Send a message to all instances
candidate.messageAll("Hello")

// Send a message to the follower instances
candidate.messageFollowers("Hello from leader")

// Send a message to the leader
candidate.messageLeader("Hello from follower")

// Get the instance's metadata
const meta = candidate.getMeta()

// Change the instance's metadata
await candidate.setMeta({
  someKey: "someValue"
})

```


```tsx
candidate.on("message:from:leader", ({ message, from }) => {
// Will be logged only in the follower instances.
  console.log(`Got message ${message} from the leader instance ${from}`);
});

candidate.on("message:from:follower", ({ message, from }) => {
  // Will be logged only in the leader instance.
  console.log(`Got message ${message} from the follower instance ${from}`);
});

```

```tsx
candidate.on("message", async ({ message, from }) => {
  const currentLeader = await candidate.getLeader();
  const isFromLeader = from === currentLeader.id;
  
  if (isFromLeader) {
    console.log(`Got message ${message} from the leader instance ${from}`);
    candidate.messageTo(from, "Echo from follower");
    // candidate.messageLeader("Echo from follower"); <- same thing in this specific case
  } else {
    console.log(`Got message ${message} from the follower instance ${from}`);
  }
});

```

Methods (all async):

- start: connects to redis, starts the candidate's internal processes
- stop: disconnects from redis, stops the candidate's internal processes
- reelect: if the candidate is the leader, starts a re-election
- messageFollowers: send message to the followers
- messageLeader: send message to the leader
- messageTo: send a message to the specific instance
- messageAll: send a message to all of the instances
- getInstances: get the instances of this kind along with their metadata
- setMeta: set the current instance's metadata

Properties:
- id: the current instance's unique generated ID
- state: "follower" | "candidate" | "leader"
- currentTerm: number
- meta: the current instance's metadata

Events:

- elected: emitted on the following state transitions:
    1. candidate -> leader
- defeated: emitted on the following state transitions:
    1. leader -> follower
    2. candidate -> follower
- message: message from the leader or the followers
- message:from:follower: message from the followers
- message:from:leader: message from the leader
- statechange: on state transition
- error: redis connection error