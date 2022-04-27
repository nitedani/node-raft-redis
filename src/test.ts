import { Candidate } from "./index";

const candidate = new Candidate({
  redis: {
    host: "localhost",
    port: 6379,
    // or url: ...
  },
  kind: "my-service",
});

candidate.on("elected", () => {
  console.log("elected");
});

candidate.run();
