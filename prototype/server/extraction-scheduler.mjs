function taskKey({ platform = "", sessionId = "", contentId = "", generation = 1 } = {}) {
  return [
    String(platform),
    String(sessionId),
    String(contentId),
    String(Number(generation) || 1),
  ].join(":");
}

export function createPlatformTaskScheduler() {
  const queues = new Map();
  const active = new Map();

  function run(identity, task) {
    const platform = String(identity?.platform || "unknown");
    const key = taskKey(identity);
    if (active.has(key)) return active.get(key);

    const previous = queues.get(platform) || Promise.resolve();
    const operation = previous.catch(() => {}).then(task);
    const tracked = operation.finally(() => {
      if (active.get(key) === tracked) active.delete(key);
      if (queues.get(platform) === tracked) queues.delete(platform);
    });
    active.set(key, tracked);
    queues.set(platform, tracked);
    return tracked;
  }

  function waitForIdle() {
    return Promise.allSettled([...queues.values()]);
  }

  return {
    run,
    waitForIdle,
    activeCount: () => active.size,
  };
}
