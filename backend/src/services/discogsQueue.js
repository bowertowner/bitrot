// backend/src/services/discogsQueue.js
const MAX_CONCURRENCY = 2;

let active = 0;
const queue = [];

export function enqueueDiscogsJob(fn) {
  return new Promise((resolve, reject) => {
    queue.push({ fn, resolve, reject });

    // Optional visibility for debugging
    if (queue.length % 50 === 0) {
      console.warn("[DiscogsQueue] queue depth:", queue.length);
    }

    drain();
  });
}

function drain() {
  while (active < MAX_CONCURRENCY && queue.length > 0) {
    const job = queue.shift();
    active++;

    Promise.resolve()
      .then(() => job.fn())
      .then((val) => job.resolve(val))
      .catch((err) => job.reject(err))
      .finally(() => {
        active--;
        drain();
      });
  }
}

export function getDiscogsQueueStats() {
  return { active, queued: queue.length, max: MAX_CONCURRENCY };
}
