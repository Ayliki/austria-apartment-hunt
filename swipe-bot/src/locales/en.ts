export default {
  help_intro: 'I find Vienna rental apartments matching your preferences and let you swipe through them, like a dating app.',
  wizard_progress: 'Step {step}/{total}',
  wizard_name_prompt: 'Name this search (e.g. "Studio Center") — or tap Skip to call it "Search {n}".',
  wizard_name_prompt_edit: 'Rename this search (e.g. "Studio Center") — or tap Skip to cancel.',
  wizard_budget_prompt: 'What\'s your budget?',
  wizard_budget_custom_prompt: 'Type your budget (e.g. €500-1200, <1200, or 500+):',
  wizard_budget_custom_error: 'I didn\'t catch that. Try a range like €500-1200, "<1200", or "500+".',
  wizard_districts_prompt: 'Which districts?',
  wizard_rooms_prompt: 'Rooms?',
  wizard_amenities_prompt: 'Any must-haves?',
  wizard_commute_prompt: 'Daily commute destination? Type an address, or tap Skip.',
  btn_skip: 'Skip',
  btn_back: '‹ Back',
  btn_continue: 'Continue',
  btn_custom_range: 'Custom range ▸',
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
  no_active_search: 'No active search — /start to set one up.',
  no_searches_yet: 'No searches yet — /start to set one up.',
  searches_header: 'Your searches:',
  search_no_longer_exists: 'That search no longer exists.',
  switched: 'Switched.',
  deleted: 'Deleted.',
  last_search_deleted: 'Deleted your last search — /start to set up a new one.',
  no_active_search_after_delete: 'Deleted. No search is active now — pick one to switch to:',
  already_has_search: 'You already have a search set up — /next for a listing, /searches to manage your searches, or /settings to edit one.',
  max_searches_reached: 'You already have {maxProfiles} searches — delete one with /searches first.',
  settings_menu_title: 'Editing "{name}" — pick a field:',
  next_no_profile: 'You haven\'t set your preferences yet — send /start to get set up.',
  next_no_listings: 'No new listings right now — check back after the next poll (every ~3h).',
  shortlist_empty: 'Your shortlist is empty — 👍 a card to save it here.',
  commute_not_found: 'Couldn\'t find that location — try being more specific, or tap Skip.',
  tap_buttons_to_continue: 'Please tap one of the buttons above to continue.',
  listing_no_longer_available: 'This listing is no longer available.',
  saved_to_shortlist: 'Saved to shortlist 👍',
  passed: 'Passed 👎',
  undo_only_last: 'You can only undo your most recent swipe.',
  swipe_undone: 'Swipe undone ↩️',
  not_in_shortlist: 'This listing is no longer in your shortlist.',
  first_shortlist_item: 'This is the first one.',
  last_shortlist_item: 'This is the last one.',
  removed_from_shortlist: 'Removed from shortlist 🗑️',
  saved_search_ready: 'Saved "{name}". New listings get checked every ~3h — I\'ll message you here as soon as something matches.',
  edit_cancelled: 'Edit cancelled.',
  updated_search: 'Updated "{name}".',
  no_matches_yet: '🏠 {name}: no matches yet — I\'ll message you here as soon as something matches.',
  elevator_parking_note: ' Note: elevator/parking data is only available for some listings, so this filter may be more restrictive than it looks.',
  aggregate_summary_lead: 'Here\'s what\'s already out there for it:',
  status_no_longer_available: '⚠️ No longer available',
  status_added_to_shortlist: '✅ Added to shortlist',
  status_passed: '👎 Passed',
  status_undone: '↩️ Undone',
  help_full:
    'I find Vienna rental apartments matching your preferences and let you swipe through them, ' +
    'like a dating app.\n\n' +
    'How it works: every ~3h I check willhaben and immobilienscout24 for new matches for each of your ' +
    'searches. When one is a genuine standout, flagged good value and ranking among the best that search ' +
    'has seen in the last month, I message you about it right away, up to a handful of times a day. ' +
    'Everything else goes into a digest at set times each day (mornings and evenings by default), so you ' +
    'still see it without getting pinged for every listing. Overnight I stay quiet: anything found during ' +
    'quiet hours waits for the next digest instead of buzzing your phone. Swipe 👍 on a card to save it to ' +
    'your shortlist, or 👎 to pass; each card keeps an ↩️ Undo button until you swipe the next one. The ' +
    'more you swipe, the better matches get: I learn which price/size/district combos you tend to like. ' +
    'You can pause any search from /settings without losing it: it keeps collecting matches quietly and ' +
    'picks up right where it left off when you resume.\n\n' +
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

  notify_instant_header: '🔥 Strong match · {name}',
  notify_digest_header: '🏠 {name} · {count} new since your last update',
  notify_digest_best: 'Best of these:',
  // Our own chrome inside a digest entry, not scraped listing content — the title and description
  // stay in whatever language the listing was written in, these labels follow the chat.
  notify_entry_rooms: '{rooms} rooms',
  notify_entry_district: 'district {district}',
  notify_entry_price_unknown: 'price n/a',
  btn_open_listing: 'Open ▸',
  notify_paused: 'Paused. "{name}" keeps collecting matches, but won\'t message you until you resume.',
  notify_resumed: 'Resumed. You\'ll hear about new matches for "{name}" again.',
  settings_notifications: '🔔 Notifications',
  notify_menu_header: 'Notifications for "{name}": {status}\nUp to {cap} instant alerts a day, plus a summary at {hours}. Quiet {quietStart}:00–{quietEnd}:00.',
  notify_status_active: 'Active',
  notify_status_paused: 'Paused',
  btn_pause_search: '⏸ Pause this search',
  btn_resume_search: '▶️ Resume this search',
  btn_notify_less: '🔉 Fewer alerts',
  btn_notify_more: '🔊 More alerts',
  card_link_text: 'Open on {source} ▸',
  card_rooms: 'rooms',
  card_floor: 'floor',
  card_available_from: 'from',
  card_value_good: '✅ good value',
  card_value_fair: 'fair price',
  card_value_premium: 'premium',
  card_lift: '🛗 Lift',
  card_parking: '🅿️ Parking',
  card_energy: '⚡ Energy',
  card_warning_waitlist: '⚠️ Municipal/waitlist housing — needs a Vormerkschein, Wohnticket, or Wiener Wohnen registration.',
  card_warning_wg: '🚪 WG — shared flat / co-living / student room, not a whole apartment.',
  card_warning_delisted: '⚠️ No longer listed — likely taken down by the advertiser.',
  btn_export_csv: '📤 Export CSV',
  export_caption: '{count} saved listings',
  export_failed: 'Could not build the export just now. Try again in a moment.',
} as const;
