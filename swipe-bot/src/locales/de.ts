export default {
  help_intro: 'Ich finde Mietwohnungen in Wien nach deinen Kriterien und zeige sie als Karten zum Durchwischen, wie bei einer Dating-App.',
  wizard_progress: 'Schritt {step}/{total}',
  wizard_name_prompt: 'Name für diese Suche (z. B. "Studio Zentrum") — oder tippe Überspringen für "Suche {n}".',
  wizard_budget_prompt: 'Wie hoch ist dein Budget?',
  wizard_districts_prompt: 'Welche Bezirke?',
  wizard_rooms_prompt: 'Zimmer & Größe?',
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
  help_full:
    'Ich finde Mietwohnungen in Wien nach deinen Kriterien und zeige sie als Karten zum Durchwischen, wie bei einer Dating-App.\n\n' +
    'So funktioniert\'s: Alle ~3 Stunden prüfe ich willhaben und immobilienscout24 auf neue Treffer für jede deiner Suchen. ' +
    'Gibt es mehrere, fasse ich sie zu einer gebündelten Push-Nachricht pro Suche zusammen, statt dich mit einzelnen Karten zu fluten. ' +
    'Wische 👍, um eine Karte in deine Merkliste zu speichern, oder 👎 zum Überspringen — jede Karte behält eine ↩️ Rückgängig-Schaltfläche, ' +
    'bis du die nächste wischst. Je mehr du wischst, desto besser werden die Treffer: ich lerne, welche Preis-/Größen-/Bezirks-Kombinationen dir gefallen.\n\n' +
    'Wenn du eine Suche fertig eingerichtet hast (oder zu einer mit bereits vorhandenen Treffern wechselst), ' +
    'schicke ich dir eine Zusammenfassung mit einer Schaltfläche „Top-Treffer ansehen ▸", um sofort loszuwischen.\n\n' +
    'Befehle:\n' +
    '/next — sofort ein weiteres Inserat anzeigen, ohne auf die nächste Prüfung zu warten\n' +
    '/shortlist — Merkliste durchsehen, eine Karte nach der anderen, mit 🗑️ Entfernen-Schaltfläche an jeder\n' +
    '/searches — gespeicherte Suchen auflisten, wechseln oder löschen (bis zu {maxProfiles})\n' +
    '/settings — Budget, Bezirke oder andere Kriterien der aktiven Suche ändern\n' +
    '/start — eine neue Suche einrichten\n' +
    '/language — die Sprache des Bots ändern\n\n' +
    'Die Schaltflächen ⏭ Weiter / 📋 Merkliste / ⚙️ Einstellungen unter dem Nachrichtenfeld tun dasselbe wie die ' +
    'zugehörigen Befehle — ein Tap statt Tippen.\n\n' +
    '{safetyNotice}',
} as const;
