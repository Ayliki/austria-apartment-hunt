export default {
  help_intro: 'I find Vienna rental apartments matching your preferences and let you swipe through them, like a dating app.',
  wizard_progress: 'Step {step}/{total}',
  wizard_name_prompt: 'Name this search (e.g. "Studio Center") — or tap Skip to call it "Search {n}".',
  wizard_budget_prompt: 'What\'s your budget?',
  wizard_districts_prompt: 'Which districts?',
  wizard_rooms_prompt: 'Rooms & size?',
  wizard_amenities_prompt: 'Any must-haves?',
  wizard_commute_prompt: 'Daily commute destination? Type an address, or tap Skip.',
  btn_skip: 'Skip',
  btn_back: '‹ Back',
  btn_continue: 'Continue',
  btn_start_searching: '✅ Start searching',
  btn_edit: '✏️ Edit',
  btn_add_another_search: '+ Add another search',
  amenity_elevator: 'Elevator',
  amenity_parking: 'Parking',
  amenity_include_waitlist: 'Include waitlist/municipal housing',
  amenity_include_wg: 'Include WG rooms',
  pet_badge: '🐾 mentions pets — check listing',
  language_prompt: 'Choose your language:',
  language_saved: 'Language set to {language}.',
  help_full:
    'I find Vienna rental apartments matching your preferences and let you swipe through them, ' +
    'like a dating app.\n\n' +
    'How it works: every ~3h I check willhaben and immobilienscout24 for new matches for each of your ' +
    'searches. If there are several, I group them into one paced push per search instead of flooding you ' +
    'card by card. Swipe 👍 on a card to save it to your shortlist, or 👎 to pass — each card keeps an ' +
    '↩️ Undo button until you swipe the next one. The more you swipe, the better matches get: I learn ' +
    'which price/size/district combos you tend to like.\n\n' +
    'When you finish setting up a search (or switch to one with matches waiting), I send a summary of ' +
    'what\'s already out there with a "Browse top matches ▸" button to start swiping right away.\n\n' +
    'Commands:\n' +
    '/next — see another listing right now, without waiting for the next poll\n' +
    '/shortlist — browse everything you\'ve liked, one card at a time, with a 🗑️ Remove button on each\n' +
    '/searches — list, switch between, or delete your saved searches (up to ' + '{maxProfiles}' + ')\n' +
    '/settings — change your budget, districts, or other preferences for the active search\n' +
    '/start — set up a new search\n' +
    '/language — change the bot\'s language\n\n' +
    'The ⏭ Next / 📋 Shortlist / ⚙️ Settings buttons below the message box do the same as the ' +
    'matching commands, one tap instead of typing.\n\n' +
    '{safetyNotice}',
  // Task 5-9 add further keys here as each screen is built; keep this file the single source of truth for the key set.
} as const;
