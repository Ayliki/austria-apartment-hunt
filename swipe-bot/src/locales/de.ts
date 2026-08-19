export default {
  help_intro: 'Ich finde Mietwohnungen in Wien nach deinen Kriterien und zeige sie als Karten zum Durchwischen, wie bei einer Dating-App.',
  wizard_progress: 'Schritt {step}/{total}',
  wizard_name_prompt: 'Name für diese Suche (z. B. "Studio Zentrum") — oder tippe Überspringen für "Suche {n}".',
  wizard_name_prompt_edit: 'Diese Suche umbenennen (z. B. "Studio Zentrum") — oder tippe Überspringen, um abzubrechen.',
  wizard_budget_prompt: 'Wie hoch ist dein Budget?',
  wizard_budget_custom_prompt: 'Gib dein Budget ein (z. B. €500-1200, <1200 oder 500+):',
  wizard_budget_custom_error: 'Das habe ich nicht verstanden. Probier eine Spanne wie €500-1200, „<1200“ oder „500+“.',
  wizard_districts_prompt: 'Welche Bezirke?',
  wizard_rooms_prompt: 'Zimmer?',
  wizard_amenities_prompt: 'Etwas Unverzichtbares?',
  wizard_commute_prompt: 'Tägliches Pendelziel? Adresse eingeben oder Überspringen tippen.',
  btn_skip: 'Überspringen',
  btn_back: '‹ Zurück',
  btn_continue: 'Weiter',
  btn_custom_range: 'Eigener Bereich ▸',
  btn_start_searching: '✅ Suche starten',
  btn_edit: '✏️ Bearbeiten',
  btn_add_another_search: '+ Weitere Suche hinzufügen',
  amenity_elevator: 'Lift',
  amenity_parking: 'Parkplatz',
  amenity_include_waitlist: 'Vormerk-/Gemeindewohnungen anzeigen',
  amenity_include_wg: 'WG-Zimmer anzeigen',
  pet_badge: '🐾 erwähnt Haustiere — bitte im Inserat prüfen',
  language_prompt: 'Sprache wählen:',
  language_saved: 'Sprache auf {language} gesetzt.',
  no_active_search: 'Keine aktive Suche — sende /start, um eine anzulegen.',
  no_searches_yet: 'Noch keine Suchen — sende /start, um eine anzulegen.',
  searches_header: 'Deine Suchen:',
  search_no_longer_exists: 'Diese Suche gibt es nicht mehr.',
  switched: 'Gewechselt.',
  deleted: 'Gelöscht.',
  last_search_deleted: 'Letzte Suche gelöscht — sende /start, um eine neue anzulegen.',
  no_active_search_after_delete: 'Gelöscht. Jetzt ist keine Suche aktiv — wähle eine aus:',
  already_has_search: 'Du hast bereits eine Suche eingerichtet — /next für ein Inserat, /searches zum Verwalten oder /settings zum Bearbeiten.',
  max_searches_reached: 'Du hast bereits {maxProfiles} Suchen — lösche erst eine über /searches.',
  settings_menu_title: '„{name}“ bearbeiten — Feld wählen:',
  next_no_profile: 'Du hast noch keine Suche eingerichtet — sende /start.',
  next_no_listings: 'Gerade keine neuen Inserate — schau nach dem nächsten Check vorbei (ca. alle 3 Stunden).',
  shortlist_empty: 'Deine Merkliste ist leer — tippe 👍 auf einer Karte, um sie zu speichern.',
  commute_not_found: 'Ort nicht gefunden — versuche eine genauere Adresse oder tippe Überspringen.',
  tap_buttons_to_continue: 'Tippe einen der Buttons oben, um fortzufahren.',
  listing_no_longer_available: 'Dieses Inserat ist nicht mehr verfügbar.',
  saved_to_shortlist: 'In Merkliste gespeichert 👍',
  passed: 'Übersprungen 👎',
  undo_only_last: 'Du kannst nur deinen letzten Swipe rückgängig machen.',
  swipe_undone: 'Swipe rückgängig ↩️',
  not_in_shortlist: 'Dieses Inserat ist nicht mehr in deiner Merkliste.',
  first_shortlist_item: 'Das ist das erste Inserat.',
  last_shortlist_item: 'Das ist das letzte Inserat.',
  removed_from_shortlist: 'Aus Merkliste entfernt 🗑️',
  saved_search_ready: '„{name}“ gespeichert. Neue Inserate werden ca. alle 3 Stunden geprüft — ich schreibe, sobald etwas passt.',
  edit_cancelled: 'Bearbeitung abgebrochen.',
  updated_search: '„{name}“ aktualisiert.',
  no_matches_yet: '🏠 {name}: noch keine Treffer — ich schreibe, sobald etwas passt.',
  elevator_parking_note: ' Hinweis: Aufzug-/Parkplatz-Daten liegen nur für manche Inserate vor, daher kann dieser Filter strenger wirken als erwartet.',
  aggregate_summary_lead: 'Das ist schon da:',
  status_no_longer_available: '⚠️ Nicht mehr verfügbar',
  status_added_to_shortlist: '✅ Zur Merkliste hinzugefügt',
  status_passed: '👎 Übersprungen',
  status_undone: '↩️ Rückgängig',
  help_full:
    'Ich finde Mietwohnungen in Wien nach deinen Kriterien und zeige sie als Karten zum Durchwischen, wie bei einer Dating-App.\n\n' +
    'So funktioniert\'s: Alle ~3 Stunden prüfe ich willhaben und immobilienscout24 auf neue Treffer für jede deiner Suchen. ' +
    'Wenn eine Anzeige wirklich heraussticht (als gutes Preis-Leistungs-Verhältnis markiert und unter den besten, die diese Suche ' +
    'im letzten Monat gesehen hat), schicke ich sie dir sofort, bis zu ein paar Mal am Tag. Alles andere sammle ich in einer ' +
    'Übersicht zu festen Zeiten am Tag (standardmäßig morgens und abends), damit du nichts verpasst, auch ohne Sofortmeldung. ' +
    'Nachts bin ich still: Was in den Ruhezeiten gefunden wird, wartet auf die nächste Übersicht, statt dein Handy zu wecken. ' +
    'Wische 👍, um eine Karte in deine Merkliste zu speichern, oder 👎 zum Überspringen, jede Karte behält eine ↩️ Rückgängig-Schaltfläche, ' +
    'bis du die nächste wischst. Je mehr du wischst, desto besser werden die Treffer: ich lerne, welche Preis-/Größen-/Bezirks-Kombinationen ' +
    'dir gefallen. Du kannst jede Suche über /settings pausieren, ohne sie zu verlieren: sie sammelt im Hintergrund weiter Treffer ' +
    'und macht dort weiter, wo sie war, sobald du sie fortsetzt.\n\n' +
    'Wenn du eine Suche fertig eingerichtet hast (oder zu einer mit bereits vorhandenen Treffern wechselst), ' +
    'schicke ich dir eine Zusammenfassung mit einer Schaltfläche "Browse top matches ▸" (auf Englisch — so steht sie auch im Chat), um sofort loszuwischen.\n\n' +
    'Befehle:\n' +
    '/next — sofort ein weiteres Inserat anzeigen, ohne auf die nächste Prüfung zu warten\n' +
    '/shortlist — Merkliste durchsehen, eine Karte nach der anderen, mit 🗑️ Entfernen-Schaltfläche an jeder\n' +
    '/searches — gespeicherte Suchen auflisten, wechseln oder löschen (bis zu {maxProfiles})\n' +
    '/settings — Budget, Bezirke oder andere Kriterien der aktiven Suche ändern\n' +
    '/start — eine neue Suche einrichten\n' +
    '/language — die Sprache des Bots ändern\n\n' +
    'Die Schaltflächen "⏭ Next" / "📋 Shortlist" / "⚙️ Settings" unter dem Nachrichtenfeld (ebenfalls auf Englisch) tun dasselbe wie die ' +
    'zugehörigen Befehle — ein Tap statt Tippen.\n\n' +
    '{safetyNotice}',

  notify_instant_header: '🔥 Starker Treffer · {name}',
  notify_digest_header: '🏠 {name} · {count} neue seit deinem letzten Update',
  notify_digest_best: 'Die besten davon:',
  notify_digest_line: '{price} · {details}',
  btn_open_listing: 'Öffnen ▸',
  notify_paused: 'Pausiert. „{name}“ sammelt weiter Treffer, meldet sich aber erst wieder, wenn du fortsetzt.',
  notify_resumed: 'Fortgesetzt. Du hörst wieder von neuen Treffern für „{name}“.',
  settings_notifications: '🔔 Benachrichtigungen',
  notify_menu_header: 'Benachrichtigungen für „{name}“: {status}\nBis zu {cap} Sofortmeldungen pro Tag, dazu eine Übersicht um {hours}. Ruhe von {quietStart}:00 bis {quietEnd}:00.',
  btn_pause_search: '⏸ Suche pausieren',
  btn_resume_search: '▶️ Suche fortsetzen',
  btn_notify_less: '🔉 Weniger',
  btn_notify_more: '🔊 Mehr',
} as const;
