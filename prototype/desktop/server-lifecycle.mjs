export function createReusableServerLifecycle(startServer, closeServer) {
  let serverPromise = null;

  async function get() {
    if (!serverPromise) {
      serverPromise = Promise.resolve()
        .then(startServer)
        .catch((error) => {
          serverPromise = null;
          throw error;
        });
    }
    return serverPromise;
  }

  async function close() {
    const pending = serverPromise;
    serverPromise = null;
    if (!pending) return;
    const server = await pending.catch(() => null);
    if (server) await closeServer(server);
  }

  return { get, close };
}
