// Linien-Icons (24×24), als SVG-Zeichenketten
const P = {
  back: '<path d="M15 5l-7 7 7 7"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  pin: '<path d="M12 21s-6.5-6-6.5-11a6.5 6.5 0 0113 0c0 5-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.4"/>',
  route: '<circle cx="6" cy="18" r="2.4"/><circle cx="18" cy="6" r="2.4"/><path d="M8.4 18H15a3 3 0 000-6H9a3 3 0 010-6h6.6"/>',
  users: '<circle cx="9" cy="8.5" r="3.3"/><path d="M3 20c0-3.3 2.7-5.5 6-5.5s6 2.2 6 5.5"/><path d="M16 5.5a3.2 3.2 0 010 6.2M18 14.8c2 .6 3.5 2.3 3.5 5.2"/>',
  share: '<path d="M12 15V4M8 8l4-4 4 4"/><path d="M5 12v6.5A1.5 1.5 0 006.5 20h11a1.5 1.5 0 001.5-1.5V12"/>',
  copy: '<rect x="8.5" y="8.5" width="11" height="11" rx="2.5"/><path d="M15.5 8.5V6A1.5 1.5 0 0014 4.5H6A1.5 1.5 0 004.5 6v8A1.5 1.5 0 006 15.5h2.5"/>',
  trash: '<path d="M4.5 7h15M9.5 7V4.5h5V7M6.5 7l.8 12a1.5 1.5 0 001.5 1.4h6.4a1.5 1.5 0 001.5-1.4l.8-12M10 11v6M14 11v6"/>',
  edit: '<path d="M4 20l1-4L16.5 4.5a2 2 0 012.8 0l.2.2a2 2 0 010 2.8L8 19z"/><path d="M14.5 6.5l3 3"/>',
  calendar: '<rect x="4" y="5.5" width="16" height="14.5" rx="3"/><path d="M4 10h16M8.5 3.5v4M15.5 3.5v4"/>',
  drag: '<path d="M5 9h14M5 15h14"/>',
  camera: '<path d="M4.5 8.5A2 2 0 016.5 6.5h1.2l1.2-2h6.2l1.2 2h1.2a2 2 0 012 2v8a2 2 0 01-2 2h-11a2 2 0 01-2-2z"/><circle cx="12" cy="12.8" r="3.3"/>',
  video: '<rect x="3.5" y="6.5" width="12" height="11" rx="2.5"/><path d="M15.5 10.5l5-3v9l-5-3"/>',
  image: '<rect x="3.5" y="4.5" width="17" height="15" rx="3"/><circle cx="9" cy="10" r="1.7"/><path d="M4 17l5-4.5 3.5 3 3-2.5 4.5 4"/>',
  locate: '<circle cx="12" cy="12" r="3.2"/><circle cx="12" cy="12" r="7.5"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3"/>',
  chevron: '<path d="M9 5l7 7-7 7"/>',
  down: '<path d="M5 9l7 7 7-7"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19 12a7 7 0 00-.1-1.2l2-1.5-2-3.4-2.3.9a7 7 0 00-2-1.2L14.2 3h-4l-.4 2.6a7 7 0 00-2 1.2l-2.3-.9-2 3.4 2 1.5A7 7 0 005 12a7 7 0 00.1 1.2l-2 1.5 2 3.4 2.3-.9a7 7 0 002 1.2l.4 2.6h4l.4-2.6a7 7 0 002-1.2l2.3.9 2-3.4-2-1.5c.1-.4.1-.8.1-1.2z"/>',
  car: '<path d="M5 16.5V12l1.6-4.2A2 2 0 018.5 6.5h7a2 2 0 011.9 1.3L19 12v4.5M3.5 16.5h17M7.5 16.5v2M16.5 16.5v2"/><circle cx="8" cy="13" r=".6"/><circle cx="16" cy="13" r=".6"/>',
  flag: '<path d="M5.5 21V4M5.5 5h11l-2 4 2 4h-11"/>',
  link: '<path d="M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1 1M14 10a4 4 0 00-5.7 0l-3 3a4 4 0 005.7 5.7l1-1"/>',
  more: '<circle cx="5.5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="18.5" cy="12" r="1.2"/>',
  logout: '<path d="M10 4.5H6.5A2 2 0 004.5 6.5v11a2 2 0 002 2H10M14.5 8l4 4-4 4M18 12H9.5"/>',
  key: '<circle cx="8" cy="15.5" r="3.7"/><path d="M10.7 12.8L19.5 4M16.5 7l2.5 2.5M14 9.5l2 2"/>',
  download: '<path d="M12 4v11M7.5 11l4.5 4.5 4.5-4.5M5 19.5h14"/>',
  book: '<path d="M5 5.5A2 2 0 017 3.5h11.5v15H7a2 2 0 00-2 2zM5 18.5v-13M9 8h6M9 11.5h6"/>',
  compass: '<circle cx="12" cy="12" r="8.5"/><path d="M15.8 8.2l-2 5.6-5.6 2 2-5.6z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M18.4 5.6l-1.8 1.8M7.4 16.6l-1.8 1.8"/>',
  play: '<path d="M8 5.5v13l11-6.5z"/>',
  cloud: '<path d="M7 18.5a4.5 4.5 0 01-.6-8.96A6 6 0 0118 10.5a4 4 0 01-.5 8z"/><path d="M12 17v-5M9.8 14l2.2-2.2 2.2 2.2"/>',
  pencil: '<path d="M4 20l1-4L16.5 4.5a2 2 0 012.8 0l.2.2a2 2 0 010 2.8L8 19z"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5M12 7.8v.2"/>',
};

export function icon(name, cls = '') {
  return `<svg class="i ${cls}" viewBox="0 0 24 24" aria-hidden="true">${P[name] || ''}</svg>`;
}

export const PIN_SVG = '<svg viewBox="0 0 34 44"><path class="body" d="M17 1C8.2 1 1 8 1 16.6 1 28 17 43 17 43s16-15 16-26.4C33 8 25.8 1 17 1z" stroke="#fff" stroke-width="2"/></svg>';

// Zeichnung für leeren Startbildschirm und Willkommensseite
export const ROAD_ART = `<svg class="art" viewBox="0 0 220 150" fill="none" aria-hidden="true">
  <circle cx="165" cy="38" r="20" fill="#F5B841" opacity=".9"/>
  <path d="M0 118 C40 96 70 108 110 92 S180 70 220 84 V150 H0Z" fill="#2F9E44" opacity=".25"/>
  <path d="M0 132 C50 108 80 122 118 106 S190 90 220 100 V150 H0Z" fill="#0B7285" opacity=".35"/>
  <path d="M-10 146 C50 120 90 136 130 118 S200 104 230 112" stroke="#16233F" stroke-width="22" stroke-linecap="round" opacity=".92"/>
  <path d="M-10 146 C50 120 90 136 130 118 S200 104 230 112" stroke="#F6F1E7" stroke-width="2.5" stroke-linecap="round" stroke-dasharray="9 11"/>
  <g transform="translate(78 70)"><path d="M0 0 h38 l9 13 v10 h-47z" fill="#E8590C"/><rect x="6" y="3" width="14" height="10" rx="2" fill="#F6F1E7" opacity=".9"/><rect x="23" y="3" width="12" height="10" rx="2" fill="#F6F1E7" opacity=".9"/><circle cx="11" cy="24" r="6.5" fill="#16233F"/><circle cx="37" cy="24" r="6.5" fill="#16233F"/><circle cx="11" cy="24" r="2.5" fill="#F6F1E7"/><circle cx="37" cy="24" r="2.5" fill="#F6F1E7"/></g>
  <path d="M30 78c0-9 7-15 15-15s15 6 15 15c0 9-15 28-15 28S30 87 30 78z" fill="#F5B841"/><circle cx="45" cy="78" r="5.5" fill="#16233F"/>
</svg>`;

export const WELCOME_ART = `<svg class="road" viewBox="0 0 400 200" fill="none" preserveAspectRatio="xMidYMax slice" aria-hidden="true">
  <defs><radialGradient id="sun" cx="50%" cy="50%" r="50%"><stop offset="0" stop-color="#FFC66B"/><stop offset="1" stop-color="#E8590C"/></radialGradient></defs>
  <circle cx="290" cy="92" r="46" fill="url(#sun)" opacity=".95"/>
  <path d="M0 130 C50 96 90 120 140 100 S240 84 300 108 S380 98 400 104 V200 H0Z" fill="#33497A"/>
  <path d="M0 150 C60 124 110 146 170 128 S280 116 340 136 S390 130 400 132 V200 H0Z" fill="#26396A"/>
  <path d="M-10 200 L168 158 C186 154 200 154 214 158 L420 200Z" fill="#0D1527"/>
  <path d="M188 200 L196 160 M204 200 L202 160" stroke="#F5B841" stroke-width="3" stroke-linecap="round" stroke-dasharray="7 10" opacity=".9"/>
  <g transform="translate(150 118)"><path d="M0 14 h46 l11 16 v12 h-57z" fill="#FF8A4C"/><path d="M10 14 l8 -12 h24 l9 12z" fill="#FF8A4C"/><path d="M16 14 l6 -9 h8 v9z M33 14 v-9 h8 l6 9z" fill="#16233F" opacity=".85"/><circle cx="14" cy="42" r="7.5" fill="#0D1527"/><circle cx="46" cy="42" r="7.5" fill="#0D1527"/><circle cx="14" cy="42" r="3" fill="#F6F1E6"/><circle cx="46" cy="42" r="3" fill="#F6F1E6"/></g>
  <circle cx="60" cy="40" r="1.6" fill="#F6F1E6" opacity=".8"/><circle cx="110" cy="62" r="1.2" fill="#F6F1E6" opacity=".6"/><circle cx="360" cy="40" r="1.6" fill="#F6F1E6" opacity=".7"/><circle cx="220" cy="28" r="1.3" fill="#F6F1E6" opacity=".6"/>
</svg>`;
