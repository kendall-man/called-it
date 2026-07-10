import { defineHook } from 'eve/hooks';
import { conciergeLifecycle } from '../runtime/lifecycle.js';

export default defineHook({
  events: {
    'session.started'(_event, context) {
      conciergeLifecycle.beginSession(context.session.id);
    },
    'session.completed'(_event, context) {
      conciergeLifecycle.finishSession(context.session.id);
    },
    'session.failed'(_event, context) {
      conciergeLifecycle.finishSession(context.session.id);
    },
  },
});
