import assert from 'node:assert/strict';
import { eventDateVariants, verifyEventContent } from './career-event-evidence.mjs';

const event = {
  date: '2026-10-09',
  name: 'Data Center Career Day, Fall 2026'
};

assert(eventDateVariants(event.date).includes('October 9, 2026'));
assert.equal(
  verifyEventContent(event, '<main><h1>Data Center Career Day, Fall 2026</h1><p>October 9, 2026 · Mesa, Arizona</p></main>').matched,
  true,
  'event name + long-form date should verify'
);
assert.equal(
  verifyEventContent(event, '<main><h1>Data Center Career Day, Fall 2026</h1><p>10/9/2026 · Mesa, Arizona</p></main>').matched,
  true,
  'event name + numeric date should verify'
);
assert.equal(
  verifyEventContent(event, '<main><h1>Data Center Career Day, Fall 2026</h1><p>October 9, 2025</p></main>').matched,
  false,
  'same event name with the wrong year must not verify'
);
assert.equal(
  verifyEventContent(event, '<main><p>October 9, 2026</p><p>General workforce programming</p></main>').matched,
  false,
  'date alone must not verify an event'
);
assert.equal(
  verifyEventContent(event, '<main><h1>Data Center Career Day, Fall 2026</h1><p>Registration information coming soon.</p></main>').matched,
  false,
  'name alone must not renew verification without the event date'
);

const escapedMarkup = verifyEventContent(
  { date: '2026-11-04', name: 'Student & Military Community Next-Gen Workforce Session' },
  '<title>Student &amp; Military Community Next-Gen Workforce Session</title><p>Nov 4, 2026</p>'
);
assert.equal(escapedMarkup.matched, true, 'HTML entities and abbreviated dates should verify');

const cancelled = verifyEventContent(
  event,
  '<main><h1>Data Center Career Day, Fall 2026</h1><p>October 9, 2026 · Mesa, Arizona</p><strong>Status: Cancelled</strong></main>'
);
assert.equal(cancelled.matched, false, 'a cancelled event must not verify even when its original date remains on the page');
assert.equal(cancelled.statusConflict, true, 'cancelled event should expose status conflict evidence');
assert.equal(cancelled.reason, 'event-cancelled-postponed-or-rescheduled');

assert.equal(
  verifyEventContent(
    event,
    '<main><h1>Data Center Career Day, Fall 2026</h1><p>October 9, 2026 · Mesa, Arizona</p><p>This event has been postponed. A new date will be announced.</p></main>'
  ).matched,
  false,
  'a postponed event must not verify under its old date'
);

assert.equal(
  verifyEventContent(
    event,
    '<main><h1>Data Center Career Day, Fall 2026</h1><p>October 9, 2026 · Mesa, Arizona</p><p>This event has been rescheduled to October 20, 2026.</p></main>'
  ).matched,
  false,
  'a rescheduled event must not verify under its old date'
);

assert.equal(
  verifyEventContent(
    event,
    '<main><h1>Data Center Career Day, Fall 2026</h1><p>October 9, 2026 · Mesa, Arizona</p><footer>Cancellation policy: registrations may be transferred up to 48 hours before the event.</footer></main>'
  ).matched,
  true,
  'generic cancellation-policy copy must not be treated as an event cancellation'
);

console.log('Career-event content-evidence tests passed.');
