import { daemon, DaemonUnavailableError } from '../control-client.js';

daemon
  .pause()
  .then(() => console.log('⏸ Sending paused. send_message will be refused until you resume.'))
  .catch((e) => {
    console.error(e instanceof DaemonUnavailableError ? e.message : String(e));
    process.exitCode = 1;
  });
