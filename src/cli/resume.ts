import { daemon, DaemonUnavailableError } from '../control-client.js';

daemon
  .resume()
  .then(() => console.log('▶️ Sending resumed. The prepare → confirm → send flow still applies.'))
  .catch((e) => {
    console.error(e instanceof DaemonUnavailableError ? e.message : String(e));
    process.exitCode = 1;
  });
