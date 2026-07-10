import { defineHook } from 'eve/hooks';
import { conciergeLifecycle } from '../runtime/lifecycle.js';
import { createConciergeSessionEvents } from '../runtime/session-intake.js';

const sessionEvents = createConciergeSessionEvents(conciergeLifecycle);

export default defineHook({
  events: {
    'session.started'(_event, context) {
      sessionEvents.started(context.session.id);
    },
    'session.completed'(_event, context) {
      sessionEvents.completed(context.session.id);
    },
    'session.failed'(_event, context) {
      sessionEvents.failed(context.session.id);
    },
  },
});
