import { daemon, DaemonUnavailableError } from '../control-client.js';

daemon
  .shutdown()
  .then(() => console.log('👋 Gateway is shutting down.'))
  .catch((e) => {
    if (e instanceof DaemonUnavailableError) {
      console.log('Gateway is not running.');
    } else {
      console.error(String(e));
      process.exitCode = 1;
    }
  });
