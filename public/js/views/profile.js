// Profil: Name, Farbe, Wiederherstellungs-Code, App installieren, Abmelden
import { h, sheet, toast, confirmDialog, iconEl, copyText } from '../ui.js';
import { net } from '../net.js';
import { state, clearCreds, loadCreds, saveRecovery } from '../state.js';
import { USER_COLORS, APP_NAME } from '../config.js';
import { avatar } from '../ui.js';
import { openRecoveryCodeSheet } from './welcome.js';

export const installer = { prompt: null };
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installer.prompt = e; window.dispatchEvent(new Event('wf-installable')); });
window.addEventListener('appinstalled', () => { installer.prompt = null; });
export const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;

export function openProfile() {
  const me = state.user;
  let color = me.color;
  const nameInput = h('input', { class: 'input', value: me.name, maxlength: '40', 'aria-label': 'Dein Name', autocomplete: 'given-name' });
  const avatarBox = h('div', { style: { display: 'flex', justifyContent: 'center', margin: '4px 0 18px' } });
  const colorRow = h('div', { class: 'color-row' });
  const drawAvatar = () => { avatarBox.replaceChildren(avatar({ name: nameInput.value || me.name, color }, 'xl')); };
  const drawColors = () => {
    colorRow.replaceChildren(...USER_COLORS.map((c) => h('button', { class: c === color ? 'on' : '', style: { background: c }, 'aria-label': 'Farbe wählen', onclick: () => { color = c; drawColors(); drawAvatar(); } })));
  };
  nameInput.addEventListener('input', drawAvatar);
  drawAvatar(); drawColors();

  const saveBtn = h('button', { class: 'btn block', onclick: async () => {
    const n = nameInput.value.trim();
    if (!n) { toast('Der Name darf nicht leer sein.'); return; }
    saveBtn.disabled = true;
    try {
      await net.request('profile.update', { name: n, color });
      const { setUser } = await import('../state.js');
      setUser({ id: me.id, name: n, color });
      toast('Gespeichert');
      layer.close();
    } catch (e) { toast(e.code === 'offline' ? 'Zum Speichern brauchst du Internet.' : e.message, { error: true }); }
    finally { saveBtn.disabled = false; }
  } }, 'Speichern');

  const creds = loadCreds();
  let shown = false;
  const codeText = h('span', null);
  const codeRow = h('div', { class: 'code-box', style: { fontSize: '19px' } }, codeText);
  const drawCode = () => { codeText.textContent = creds?.recovery ? (shown ? creds.recovery : '••••-••••-••••-••••') : 'Nicht auf diesem Gerät gespeichert'; };
  drawCode();

  const body = h('div', null,
    avatarBox,
    h('label', { class: 'field' }, h('span', null, 'Dein Name'), nameInput),
    h('div', { class: 'field' }, h('span', null, 'Deine Farbe'), colorRow),
    saveBtn,
    h('div', { class: 'spacer' }),
    h('div', { class: 'group', style: { margin: '14px 0' } },
      h('h3', null, 'Dein Profil sichern'),
      h('div', { style: { padding: '0 14px 6px' } },
        h('p', { class: 'muted small', style: { margin: '0 0 4px' } }, 'Mit diesem Code kommst du auf einem neuen Handy wieder an deine Reisen.'),
        codeRow,
        h('div', { class: 'row' },
          creds?.recovery ? h('button', { class: 'btn soft small', onclick: () => { shown = !shown; drawCode(); } }, 'Ein-/Ausblenden') : null,
          creds?.recovery ? h('button', { class: 'btn soft small', onclick: async () => toast((await copyText(creds.recovery)) ? 'Code kopiert' : 'Kopieren nicht möglich') }, 'Kopieren') : null,
        ),
        h('button', { class: 'link-btn', onclick: async () => {
          const ok = await confirmDialog({ title: 'Neuen Code erzeugen?', text: 'Der alte Code funktioniert danach nicht mehr. Geräte, die schon angemeldet sind, bleiben es.', confirmLabel: 'Neuen Code erzeugen' });
          if (!ok) return;
          try {
            const { code } = await net.request('profile.newCode');
            saveRecovery(code);
            await layer.close();
            await openRecoveryCodeSheet(code, { title: 'Dein neuer Code' });
          } catch (e) { toast(e.code === 'offline' ? 'Dafür brauchst du Internet.' : e.message, { error: true }); }
        } }, 'Neuen Code erzeugen'),
      )),
    !isStandalone() && installer.prompt ? h('button', { class: 'btn soft block', style: { marginBottom: '12px' }, onclick: async () => { installer.prompt.prompt(); await installer.prompt.userChoice.catch(() => {}); installer.prompt = null; layer.close(); } }, 'App installieren') : null,
    h('button', { class: 'btn danger block', onclick: async () => {
      const ok = await confirmDialog({ title: 'Von diesem Gerät abmelden?', text: 'Deine Reisen bleiben gespeichert. Zum Wiederanmelden brauchst du deinen Wiederherstellungs-Code.', confirmLabel: 'Abmelden', danger: true });
      if (!ok) return;
      await layer.close();
      clearCreds();
      location.href = '/';
    } }, 'Abmelden'),
    h('p', { class: 'center muted small', style: { marginTop: '18px' } }, `${APP_NAME} · Version 0.1`),
  );
  const layer = sheet({ title: 'Dein Profil', body });
  void iconEl;
  return layer;
}
