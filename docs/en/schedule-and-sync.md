# Schedule and synchronization

[中文](../schedule-and-sync.md) · English

The schedule combines courses, available assignment deadlines, custom events and configured calendar data. Assignment visibility is not exclusive to full mode. Check the same week and data source when comparing modes.

Custom events support repeat rules in the editor: daily, weekly, biweekly or monthly (weekly variants pick weekdays), ending never or on an inclusive end date. Saving and deleting apply to the whole series. Course export and system-calendar output expand repeats into individual instances; native RRULE is not written to the system calendar (see ADR-0001, Chinese). Yearly (YEARLY) rules are outside the parsing scope and import as a single first occurrence.

Use timeline or list views as appropriate. Lists must scroll to the final item with the bottom controls visible. Assignment actions open the assignment in a new tab; course actions can open the learning-platform course or its trace page, according to available data and mode navigation.

External homework platforms, including Rain Classroom and supported OJ systems, require their own connection where applicable. A missing source is different from an empty assignment list. Do not assume an unavailable platform has no deadlines.

CalDAV and iCalendar integration deal with event synchronization/subscription. IMAP mail integration deals with messages; it is not a calendar-synchronization protocol. Check account/server configuration, TLS, authorization and collection settings for each service independently. Do not paste passwords into reports.

System reminders also depend on OS notification permission, background restrictions and configured lead times/quiet hours. Desktop and Android behavior can differ. A successful frontend test does not establish background delivery on a physical phone.
