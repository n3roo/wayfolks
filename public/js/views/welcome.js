// Willkommen: Profil anlegen (nur ein Name) oder per Code wiederherstellen
import { h, toast, sheet, iconEl, copyText } from '../ui.js';
import { WELCOME_ART } from '../icons.js';
import { net } from '../net.js';
import { state } from '../state.js';
import { APP_NAME } from '../config.js';
import { tripCoverUrl } from '../util.js';
import { ROLE_LABEL } from '../config.js';

export function openRecoveryCodeSheet(code, { onDone, title = 'Dein Wiederherstellungs-Code' } = {}) {
  return new Promise((resolve) => {
    let confirmed = false;
    const btn = h('button', { class: 'btn block', disabled: true, onclick: () => { confirmed = true; layer.close(); } }, 'Weiter');
    const check = h('button', { class: 'check-row', onclick: () => { check.classList.toggle('on'); btn.disabled = !check.classList.contains('on'); } },
      h('span', { class: 'box' }, iconEl('check', 'sm')), h('span', null, 'Ich habe den Code sicher notiert'));
    const body = h('div', null,
      h('p', { class: 'muted', style: { marginTop: 0 } }, 'Es gibt keine Passwörter. Mit diesem Code kommst du auf einem neuen Handy wieder an deine Reisen. Speichere ihn zum Beispiel in deinem Passwort-Manager oder schick ihn dir selbst.'),
      h('div', { class: 'code-box' }, code),
      h('div', { class: 'row', style: { marginBottom: '16px' } },
        h('button', { class: 'btn soft', onclick: async () => { toast((await copyText(code)) ? 'Code kopiert' : 'Kopieren nicht möglich', {}); } }, 'Kopieren'),
        h('button', { class: 'btn soft', onclick: async () => {
          if (navigator.share) { try { await navigator.share({ title: `${APP_NAME}-Code`, text: `Mein ${APP_NAME}-Wiederherstellungs-Code: ${code}` }); } catch {} }
          else toast((await copyText(code)) ? 'Code kopiert' : 'Kopieren nicht möglich');
        } }, 'Teilen')),
      check, btn);
    const layer = sheet({ title, body, dismissible: false, onClose: () => { onDone?.(confirmed); resolve(confirmed); } });
  });
}

export function welcomeView({ inviteToken, message, startMode = 'new', onRegistered }) {
  const root = h('div', { class: 'view welcome' });
  let mode = startMode;
  let invite = null;
  let busy = false;

  const panel = h('div', { class: 'panel' });
  const inviteBox = h('div');

  async function loadInvite() {
    if (!inviteToken) return;
    try {
      invite = await net.peek(inviteToken);
    } catch (e) {
      invite = { error: e.message || 'Der Einladungslink ist nicht mehr gültig.' };
    }
    drawInvite();
    drawPanel();
  }

  function drawInvite() {
    inviteBox.replaceChildren();
    if (!inviteToken) return;
    if (!invite) { inviteBox.append(h('div', { class: 'invite pulse' }, h('div', { class: 'thumb' }), h('div', null, h('b', null, 'Einladung wird geladen …')))); return; }
    if (invite.error) { inviteBox.append(h('div', { class: 'invite' }, h('div', null, h('b', null, 'Einladung ungültig'), h('span', null, invite.error)))); return; }
    const thumb = h('div', { class: 'thumb' });
    const url = tripCoverUrl({ id: invite.trip_id, has_cover: invite.has_cover, cover_version: invite.cover_version });
    if (url) thumb.style.backgroundImage = `url(${url})`;
    inviteBox.append(h('div', { class: 'invite' }, thumb, h('div', null,
      h('span', null, `${invite.owner_name} lädt dich ein zu`),
      h('b', null, invite.title),
      h('span', null, `${ROLE_LABEL[invite.role]} · ${invite.member_count} ${invite.member_count === 1 ? 'Person' : 'Personen'} dabei`))));
  }

  function drawPanel() {
    panel.replaceChildren();
    if (mode === 'new') {
      const name = h('input', { class: 'input', placeholder: 'Dein Name', maxlength: '40', autocomplete: 'given-name', autocapitalize: 'words', enterkeyhint: 'go', 'aria-label': 'Dein Name' });
      const go = h('button', { class: 'btn block', onclick: submit }, inviteToken && invite && !invite.error ? 'Beitreten & loslegen' : 'Los geht’s');
      async function submit() {
        const n = name.value.trim();
        if (!n) { name.focus(); toast('Wie sollen dich die anderen nennen?'); return; }
        if (busy) return;
        busy = true; go.disabled = true; go.textContent = 'Einen Moment …';
        try {
          const { recoveryCode } = await net.register(n);
          await openRecoveryCodeSheet(recoveryCode);
          onRegistered?.();
        } catch (e) {
          toast(e.message || 'Das hat leider nicht geklappt.', { error: true });
        } finally { busy = false; go.disabled = false; go.textContent = 'Los geht’s'; }
      }
      name.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
      panel.append(...[
        message ? h('p', { class: 'muted', style: { marginTop: 0 } }, message) : null,
        h('label', { class: 'field' }, h('span', null, 'Wie heißt du?'), name), go,
        h('button', { class: 'link-btn', onclick: () => { mode = 'recover'; drawPanel(); } }, 'Ich habe schon ein Profil'),
      ].filter(Boolean));
    } else {
      const code = h('input', { class: 'input code-input', placeholder: 'XXXX-XXXX-XXXX-XXXX', maxlength: '24', autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false', enterkeyhint: 'go', 'aria-label': 'Wiederherstellungs-Code' });
      const go = h('button', { class: 'btn block', onclick: submit }, 'Profil wiederherstellen');
      async function submit() {
        const c = code.value.trim();
        if (c.replace(/[^A-Za-z0-9]/g, '').length < 16) { toast('Der Code besteht aus 16 Zeichen.'); code.focus(); return; }
        if (busy) return;
        busy = true; go.disabled = true; go.textContent = 'Prüfe …';
        try {
          await net.recover(c);
          toast('Willkommen zurück!');
          onRegistered?.();
        } catch (e) {
          toast(e.message || 'Das hat leider nicht geklappt.', { error: true });
        } finally { busy = false; go.disabled = false; go.textContent = 'Profil wiederherstellen'; }
      }
      code.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
      code.addEventListener('input', () => {
        const raw = code.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 16);
        code.value = raw.match(/.{1,4}/g)?.join('-') || '';
      });
      panel.append(...[
        message ? h('p', { class: 'muted', style: { marginTop: 0 } }, message) : null,
        h('p', { class: 'muted', style: { marginTop: 0 } }, 'Gib den Code ein, den du beim ersten Start bekommen hast.'),
        h('label', { class: 'field' }, h('span', null, 'Wiederherstellungs-Code'), code), go,
        h('button', { class: 'link-btn', onclick: () => { mode = 'new'; drawPanel(); } }, 'Neu starten'),
      ].filter(Boolean));
    }
  }

  root.append(
    h('div', { class: 'hero' },
      h('img', { src: '/icons/icon-192.png', alt: '', width: 92, height: 92 }),
      h('h1', null, APP_NAME),
      h('p', { class: 'tag' }, 'Plant eure Roadtrips gemeinsam und erinnert euch später an jeden Stopp.')),
    inviteBox,
    h('div', { html: WELCOME_ART }),
    panel,
  );
  drawInvite();
  drawPanel();
  loadInvite();
  void state;
  return { el: root, destroy() {} };
}
