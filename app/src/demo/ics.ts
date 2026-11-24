// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors
//
// Check-in reminders as a calendar file, made on this device. No server
// learns who you are or when your deadline is. The entries say only
// "Check in", never anything about heirs.

const stamp = (t: number, floating = false) => {
  const d = new Date(t * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return floating
    ? `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}T090000`
    : `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
};

export interface Reminder { at: number; title: string; body: string }

export function remindersFor(deadline: number, now: number): Reminder[] {
  const day = 86_400;
  return [
    { at: deadline - 7 * day, title: 'Check in: 7 days left', body: 'Open Codicil and tap I’m alive. It takes one touch.' },
    { at: deadline - day, title: 'Check in: due tomorrow', body: 'Open Codicil and tap I’m alive before tomorrow.' },
  ].filter((r) => r.at > now);
}

export function calendarFile(reminders: Reminder[], now: number, url: string): string {
  const esc = (s: string) => s.replace(/[\;,]/g, (c) => `\\${c}`).replace(/\n/g, '\\n');
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Codicil//Check-in reminders//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH'];
  reminders.forEach((r, i) => {
    lines.push(
      'BEGIN:VEVENT',
      `UID:codicil-${r.at}-${i}@codicil.local`,
      `DTSTAMP:${stamp(now)}`,
      `DTSTART:${stamp(r.at, true)}`,
      'DURATION:PT15M',
      `SUMMARY:${esc(r.title)}`,
      `DESCRIPTION:${esc(`${r.body}\n${url}`)}`,
      'BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${esc(r.title)}`, 'TRIGGER:PT0M', 'END:VALARM',
      'END:VEVENT',
    );
  });
  lines.push('END:VCALENDAR');
  return lines.join('\r\n') + '\r\n';
}

export function downloadCalendar(text: string, name = 'codicil-check-in.ics') {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/calendar' }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
