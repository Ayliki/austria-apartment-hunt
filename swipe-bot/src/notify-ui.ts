import { Markup } from 'telegraf';
import { type DB, type SearchProfile, getNotifySettings } from './db.js';
import { t } from './locales.js';

/** Discrete choices for instant alerts per day. 0 means digest-only; the user never types a number. */
export const CAP_LADDER = [0, 1, 3, 6, 12];

/** Next rung in the requested direction, snapping an off-ladder value onto the nearest rung first. */
export function nextDailyCap(current: number, direction: 'less' | 'more'): number {
  const nearest = CAP_LADDER.reduce((best, v) =>
    Math.abs(v - current) < Math.abs(best - current) ? v : best, CAP_LADDER[0]);
  const index = CAP_LADDER.indexOf(nearest);
  const next = direction === 'less' ? index - 1 : index + 1;
  return CAP_LADDER[Math.max(0, Math.min(CAP_LADDER.length - 1, next))];
}

const pad = (h: number): string => `${String(h).padStart(2, '0')}:00`;

export function renderNotifyMenu(
  db: DB, chatId: number, profile: SearchProfile,
): { text: string; keyboard: ReturnType<typeof Markup.inlineKeyboard> } {
  const s = getNotifySettings(db, profile.id);
  const status = t(db, chatId, s.paused ? 'notify_status_paused' : 'notify_status_active');

  const text = t(db, chatId, 'notify_menu_header', {
    name: profile.name,
    status,
    cap: s.dailyCap,
    hours: s.digestHours.map(pad).join(' & '),
    quietStart: s.quietStart,
    quietEnd: s.quietEnd,
  });

  const toggle = s.paused
    ? Markup.button.callback(t(db, chatId, 'btn_resume_search'), `notify:resume:${profile.id}`)
    : Markup.button.callback(t(db, chatId, 'btn_pause_search'), `notify:pause:${profile.id}`);

  return {
    text,
    keyboard: Markup.inlineKeyboard([
      [toggle],
      [
        Markup.button.callback(t(db, chatId, 'btn_notify_less'), `notify:cap:less:${profile.id}`),
        Markup.button.callback(t(db, chatId, 'btn_notify_more'), `notify:cap:more:${profile.id}`),
      ],
    ]),
  };
}
