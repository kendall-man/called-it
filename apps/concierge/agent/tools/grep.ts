// Locked down: the concierge talks and calls the engine API — it must not
// touch a shell, filesystem, or the open web (see the security model in the
// migration plan).
import { disableTool } from 'eve/tools';

export default disableTool();
