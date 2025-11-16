// app.js

const state = {
  rawContacts: [],
  contacts: [],
  disclaimerAccepted: false,
  originalFileName: null
};

let disclaimerModal;

// Initialization
document.addEventListener('DOMContentLoaded', () => {
  const fileInput = document.getElementById('fileInput');
  const helpButton = document.getElementById('helpButton');
  const backToMainButton = document.getElementById('backToMainButton');
  const selectAllKeepButton = document.getElementById('selectAllKeep');
  const selectAllRemoveButton = document.getElementById('selectAllRemove');
  const exportButton = document.getElementById('exportButton');

  const disclaimerAccept = document.getElementById('disclaimerAccept');
  const disclaimerDecline = document.getElementById('disclaimerDecline');
  disclaimerModal = new bootstrap.Modal(document.getElementById('disclaimerModal'));

  fileInput.addEventListener('change', onFileSelected);
  helpButton.addEventListener('click', () => showView('help'));
  backToMainButton.addEventListener('click', () => showView('main'));
  selectAllKeepButton.addEventListener('click', () => setAllSelected(true));
  selectAllRemoveButton.addEventListener('click', () => setAllSelected(false));
  exportButton.addEventListener('click', onExportClicked);

  disclaimerAccept.addEventListener('click', onDisclaimerAccepted);
  disclaimerDecline.addEventListener('click', onDisclaimerDeclined);

  // Delegate checkbox changes
  const contactsList = document.getElementById('contactsList');
  contactsList.addEventListener('change', onContactCheckboxChange);

  // Register service worker
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(console.error);
    });
  }
});

// View switching
function showView(view) {
  const mainView = document.getElementById('mainView');
  const helpView = document.getElementById('helpView');

  if (view === 'help') {
    mainView.classList.add('d-none');
    helpView.classList.remove('d-none');
  } else {
    helpView.classList.add('d-none');
    mainView.classList.remove('d-none');
  }
}

// File upload handler
function onFileSelected(event) {
  const file = event.target.files[0];
  const uploadStatus = document.getElementById('uploadStatus');
  const uploadError = document.getElementById('uploadError');

  uploadError.classList.add('d-none');
  uploadError.textContent = '';
  uploadStatus.textContent = '';

  if (!file) return;

  state.originalFileName = file.name;

  const reader = new FileReader();
  reader.onload = () => {
    try {
      const text = reader.result;
      const data = JSON.parse(text);

      if (!data || !Array.isArray(data.contacts)) {
        throw new Error('JSON does not contain a "contacts" array.');
      }

      state.rawContacts = data.contacts;
      processContacts();

      uploadStatus.textContent = `Loaded ${state.rawContacts.length} contacts from "${file.name}".`;
      document.getElementById('summarySection').classList.remove('d-none');
      document.getElementById('contactsSection').classList.remove('d-none');
      document.getElementById('exportSection').classList.remove('d-none');
    } catch (err) {
      console.error(err);
      uploadError.textContent =
        'The selected file is not a supported Meshcore contacts JSON. ' +
        'Please export your contacts from Meshcore and try again.';
      uploadError.classList.remove('d-none');

      // Reset state on error
      state.rawContacts = [];
      state.contacts = [];
      renderContacts();
      updateSummary();
      document.getElementById('summarySection').classList.add('d-none');
      document.getElementById('contactsSection').classList.add('d-none');
      document.getElementById('exportSection').classList.add('d-none');
    }
  };

  reader.onerror = () => {
    uploadError.textContent = 'Could not read the selected file.';
    uploadError.classList.remove('d-none');
  };

  reader.readAsText(file);
}

// Contact processing & rules
function processContacts() {
  const now = new Date();
  const nowMs = now.getTime();

  state.contacts = state.rawContacts.map((c, index) => {
    const typeInfo = classifyType(c.type);
    const isFavorite = detectFavorite(c.flags);
    const lastHeard = computeLastHeard(c);
    const ageDays = lastHeard
      ? Math.floor((nowMs - lastHeard.getTime()) / (1000 * 60 * 60 * 24))
      : null;

    // Initial suggestion (without route usage for repeaters)
    let suggestedAction = 'keep';
    let reason = 'Kept by default.';

    if (typeInfo.typeLabel === 'repeater') {
      const olderThan10Days = ageDays !== null && ageDays > 10;
      if (olderThan10Days && !isFavorite) {
        suggestedAction = 'remove';
        reason = `Repeater: not heard for ${ageDays} days, not favorite.`;
      } else {
        reason = 'Repeater: recently heard or favorite.';
      }
    } else if (typeInfo.typeLabel === 'companion') {
      const olderThan10Days = ageDays !== null && ageDays > 10;
      const hasCustomPath = hasNonDefaultPath(c.out_path);
      if (olderThan10Days && !isFavorite && !hasCustomPath) {
        suggestedAction = 'remove';
        reason = `Companion: not heard for ${ageDays} days, not favorite, no custom path.`;
      } else {
        reason = 'Companion: recently heard, favorite, or has custom path.';
      }
    } else if (typeInfo.typeLabel === 'sensor') {
      if (!isFavorite) {
        suggestedAction = 'remove';
        reason = 'Sensor: not marked as favorite.';
      } else {
        reason = 'Sensor: favorite sensors are kept.';
      }
    } else if (typeInfo.typeLabel === 'room') {
      suggestedAction = 'keep';
      reason = 'Room: rooms are never suggested for removal.';
    } else {
      reason = 'Unknown type: kept by default.';
    }

    return {
      raw: c,
      id: index,
      displayName: c.custom_name || c.name || '(unnamed)',
      typeCode: c.type,
      typeLabel: typeInfo.typeLabel,
      isFavorite,
      lastHeard,
      ageDays,
      suggestedAction,
      selected: suggestedAction === 'keep',
      reason
    };
  });

  // Second pass: ensure repeaters used in routes of kept contacts are not removed
  keepRepeatersUsedInPaths();

  renderContacts();
  updateSummary();
}

// Type classification (adjust mapping as needed)
// Type classification according to Meshcore:
// 1 = companion, 2 = repeater, 3 = roomserver, 4 = sensor
function classifyType(typeCode) {
  let typeLabel = 'unknown';
  switch (typeCode) {
    case 1:
      typeLabel = 'companion';
      break;
    case 2:
      typeLabel = 'repeater';
      break;
    case 3:
      typeLabel = 'room';
      break;
    case 4:
      typeLabel = 'sensor';
      break;
    default:
      typeLabel = 'unknown';
  }
  return { typeLabel };
}

// Favorite detection (adjust according to Meshcore flag bit)
// flags = 1 means favorite
function detectFavorite(flags) {
  if (typeof flags !== 'number') return false;
  // Example assumption: bit 0 (1) = favorite
  return (flags & 1) === 1;
}

// Compute lastHeard date from last_advert / last_modified
function computeLastHeard(contact) {
  const lastAdvert = typeof contact.last_advert === 'number'
    ? contact.last_advert
    : null;
  const lastModified = typeof contact.last_modified === 'number'
    ? contact.last_modified
    : null;

  const ts = Math.max(
    lastAdvert !== null ? lastAdvert : -Infinity,
    lastModified !== null ? lastModified : -Infinity
  );

  if (!isFinite(ts)) return null;

  // Assumption: ts is Unix timestamp in seconds
  return new Date(ts * 1000);
}

// Check if out_path is a non-default/custom path
function hasNonDefaultPath(outPath) {
  if (!outPath) return false;
  const trimmed = String(outPath).trim().toLowerCase();
  if (!trimmed) return false;

  // Example for default flood routing markers – adjust as needed
  if (trimmed === 'flood' || trimmed === 'ff' || trimmed === '0') {
    return false;
  }
  return true;
}

// Ensure repeaters used in kept contacts' routes are kept
function keepRepeatersUsedInPaths() {
  const keptContacts = state.contacts.filter(c => c.selected);
  const usedPrefixes = new Set();

  keptContacts.forEach(contact => {
    const outPath = contact.raw.out_path;
    if (!outPath) return;
    // Simplified: we assume the first two characters of a repeater public_key
    // appear somewhere in out_path string.
    const pathStr = String(outPath);
    state.contacts
      .filter(c => c.typeLabel === 'repeater')
      .forEach(rep => {
        const prefix = (rep.raw.public_key || '').substring(0, 2);
        if (prefix && pathStr.includes(prefix)) {
          usedPrefixes.add(prefix);
        }
      });
  });

  state.contacts.forEach(contact => {
    if (contact.typeLabel !== 'repeater') return;
    const prefix = (contact.raw.public_key || '').substring(0, 2);
    if (prefix && usedPrefixes.has(prefix) && contact.suggestedAction === 'remove') {
      contact.suggestedAction = 'keep';
      contact.selected = true;
      contact.reason += ' Repeater is used in routing paths of kept contacts.';
    }
  });
}

// Rendering
function renderContacts() {
  const listEl = document.getElementById('contactsList');
  if (state.contacts.length === 0) {
    listEl.innerHTML = '<p class="text-muted small mb-0">No contacts loaded yet.</p>';
    return;
  }

  const html = state.contacts
    .map(contact => {
      const pk = contact.raw.public_key || '';
      const pkShort = pk.length > 10 ? pk.substring(0, 10) + '…' : pk;
      const isRemove = !contact.selected;
      const cardClasses = ['contact-card', 'd-flex'];
      if (contact.suggestedAction === 'remove') {
        cardClasses.push('contact-card-remove');
      }

      return `
        <div class="${cardClasses.join(' ')}" data-contact-id="${contact.id}">
          <div class="contact-checkbox d-flex align-items-start pt-1">
            <input
              type="checkbox"
              class="form-check-input"
              data-contact-id="${contact.id}"
              ${contact.selected ? 'checked' : ''}
            >
          </div>
          <div class="contact-main flex-grow-1">
            <div class="d-flex justify-content-between align-items-center">
              <div class="contact-name">
                ${escapeHtml(contact.displayName)}
              </div>
              ${
                contact.suggestedAction === 'remove'
                  ? '<span class="badge bg-danger badge-remove ms-2">remove</span>'
                  : ''
              }
            </div>
            <div class="contact-meta">
              ${escapeHtml(contact.typeLabel)} • ${escapeHtml(pkShort)}
              ${
                contact.isFavorite
                  ? ' • <span class="badge bg-warning text-dark">favorite</span>'
                  : ''
              }
            </div>
            <div class="contact-reason">
              ${escapeHtml(contact.reason)}
            </div>
          </div>
        </div>
      `;
    })
    .join('');

  listEl.innerHTML = html;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Checkbox change handler
function onContactCheckboxChange(event) {
  const target = event.target;
  if (target.tagName.toLowerCase() !== 'input' || target.type !== 'checkbox') {
    return;
  }

  const id = Number(target.getAttribute('data-contact-id'));
  const contact = state.contacts.find(c => c.id === id);
  if (!contact) return;

  contact.selected = target.checked;
  updateSummary();
}

// Update summary
function updateSummary() {
  const total = state.contacts.length;
  const kept = state.contacts.filter(c => c.selected).length;
  const removed = total - kept;

  document.getElementById('totalCount').textContent = total;
  document.getElementById('keepCount').textContent = kept;
  document.getElementById('removeCount').textContent = removed;
}

// Set all selected / deselected
function setAllSelected(value) {
  state.contacts.forEach(c => {
    c.selected = value;
  });
  renderContacts();
  updateSummary();
}

// Export logic
function onExportClicked() {
  if (!state.contacts.length) return;

  if (!state.disclaimerAccepted) {
    disclaimerModal.show();
    return;
  }

  generateAndDownloadJson();
}

function onDisclaimerAccepted() {
  state.disclaimerAccepted = true;
  disclaimerModal.hide();
  generateAndDownloadJson();
}

function onDisclaimerDeclined() {
  // Nothing to do: just close modal, stay on screen
  disclaimerModal.hide();
}

function generateAndDownloadJson() {
  const keptContacts = state.contacts
    .filter(c => c.selected)
    .map(c => c.raw);

  const output = {
    contacts: keptContacts
  };

  const blob = new Blob([JSON.stringify(output, null, 2)], {
    type: 'application/json'
  });

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const baseName = state.originalFileName
    ? state.originalFileName.replace(/\.json$/i, '')
    : 'meshcore_contacts';
  a.href = url;
  a.download = baseName + '_cleaned.json';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
