// Static achievement set (spec §6): first completion, mechanic mastery,
// sustained streak, difficult content milestone, accessibility-neutral
// long-term goal. Keys are stable lowercase identifiers; unlocks idempotent.

export const ACHIEVEMENTS = [
  { key: 'first-win', name: 'First Light', desc: 'Win your first match.', icon: '◈' },
  { key: 'angle-master', name: 'Angle Master', desc: 'Land 50 angled returns (outer-half paddle hits).', icon: '∠', progress: 50 },
  { key: 'streak-5', name: 'Five Alive', desc: 'Win 5 matches in a row.', icon: '↟', progress: 5 },
  { key: 'mastery-all', name: 'Mastery Track', desc: 'Clear every Mastery stage in Journey.', icon: '✦', progress: 5 },
  { key: 'centurion', name: 'Centurion', desc: 'Complete 100 matches, any mode.', icon: '❖', progress: 100 },
  { key: 'daily-devotee', name: 'Daily Devotee', desc: 'Finish 7 daily challenges.', icon: '☀', progress: 7 },
  { key: 'journey-half', name: 'Half the Horizon', desc: 'Clear 20 Journey stages.', icon: '◐', progress: 20 },
  { key: 'journey-complete', name: 'Full Circuit', desc: 'Clear all 40 Journey stages.', icon: '●', progress: 40 },
  { key: 'untouchable', name: 'Untouchable', desc: 'Win a match without conceding a single point.', icon: '⛨' },
  { key: 'challenger', name: 'Challenge Accepted', desc: 'Clear all six Challenges.', icon: '⚑', progress: 6 },
];

export function getAchievement(key) {
  return ACHIEVEMENTS.find((a) => a.key === key) || null;
}
