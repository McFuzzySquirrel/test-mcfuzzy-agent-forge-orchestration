'use strict';

/**
 * Tasker Mail web UI client (PRD §7.2 `src/public/app.js`, Phase 4 task 4.1).
 *
 * Vanilla-JS `fetch()` client against the REST API (PRD §7.3). No build step,
 * no framework. Responsibilities:
 *
 *   GET    /api/tasks        -> render the list (FR-02, FR-15)
 *   POST   /api/tasks        -> create (FR-01)
 *   PATCH  /api/tasks/:id    -> complete / reopen (FR-05, FR-06)
 *   DELETE /api/tasks/:id    -> delete (FR-07)
 *
 * After every mutation the list is re-rendered from a fresh GET response
 * (never patched row-by-row by hand). Server errors arrive as
 * `{ "error": "..." }` (NF-04) and are surfaced in the DOM and announced
 * (ACC-02). All stored content is text-escaped before insertion into the DOM
 * to prevent XSS.
 */

(function () {
  'use strict';

  var API_BASE = '/api/tasks';
  var MAX_DESCRIPTION_LENGTH = 160;

  var statusBox = document.getElementById('app-status');
  var taskList = document.getElementById('task-list');
  var emptyState = document.getElementById('empty-state');
  var listMeta = document.getElementById('list-meta');
  var form = document.getElementById('create-form');
  var createBtn = document.getElementById('create-btn');

  var TITLE_INPUT = document.getElementById('task-title');
  var DESCRIPTION_INPUT = document.getElementById('task-description');
  var EMAIL_INPUT = document.getElementById('task-email');

  var STATUS_BADGES = {
    pending: { label: 'Pending', className: 'badge badge-pending' },
    completed: { label: 'Completed', className: 'badge badge-completed' },
  };

  var NOTIF_BADGES = {
    pending: { label: 'Email: pending', className: 'badge badge-notif-pending' },
    sent: { label: 'Email: sent', className: 'badge badge-notif-sent' },
    failed: { label: 'Email: failed', className: 'badge badge-notif-failed' },
  };

  /** Escape user-supplied text so it can never become markup (XSS guard). */
  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /**
   * Wrap `fetch()` with JSON parsing and consistent error extraction.
   * Throws an Error whose message is the API's `{ "error": "..." }` message,
   * or a sensible fallback for network/parse failures (NF-04, ACC-02).
   */
  async function api(path, options) {
    var res;
    try {
      res = await fetch(path, options);
    } catch (err) {
      throw new Error('Network error - is the server running?');
    }

    var text = await res.text();
    var body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch (err) {
      body = null;
    }

    if (!res.ok) {
      var message = body && body.error ? body.error : 'Request failed (HTTP ' + res.status + ')';
      throw new Error(message);
    }
    return body;
  }

  /** Truncate a long description for the list row (PRD §12). */
  function truncate(value, max) {
    var text = String(value == null ? '' : value);
    if (text.length <= max) {
      return text;
    }
    return text.slice(0, max - 1).replace(/\s+$/, '') + '\u2026';
  }

  /** Show a message in the DOM status region and announce it (ACC-02). */
  function showStatus(message, kind) {
    statusBox.textContent = message;
    statusBox.className = 'status ' + (kind === 'success' ? 'status-success' : 'status-error');
    statusBox.hidden = !message;
    // Errors are announced immediately; informational updates politely.
    statusBox.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  }

  function clearStatus() {
    showStatus('', 'success');
  }

  function badgeHtml(badges, key, fallback) {
    var badge = badges[key] || { label: key || fallback, className: 'badge' };
    return '<span class="' + badge.className + '">' + escapeHtml(badge.label) + '</span>';
  }

  /** Build one task row: title, truncated description, badges, actions. */
  function renderTask(task) {
    var li = document.createElement('li');
    li.className = 'task';

    var description = task.description
      ? '<p class="task-description" title="' +
        escapeHtml(task.description) +
        '">' +
        escapeHtml(truncate(task.description, MAX_DESCRIPTION_LENGTH)) +
        '</p>'
      : '';

    var toggleAction = task.status === 'completed' ? 'reopen' : 'complete';
    var toggleLabel = task.status === 'completed' ? 'Reopen' : 'Complete';

    li.innerHTML =
      '<div class="task-main">' +
        '<h3 class="task-title">' + escapeHtml(task.title) + '</h3>' +
        description +
        '<p class="task-meta">Notify: ' + escapeHtml(task.notify_email) + '</p>' +
      '</div>' +
      '<div class="task-side">' +
        '<div class="badges">' +
          badgeHtml(STATUS_BADGES, task.status, 'pending') +
          badgeHtml(NOTIF_BADGES, task.notif_status, 'pending') +
        '</div>' +
        '<div class="actions">' +
          '<button type="button" class="btn btn-secondary" data-action="' +
            toggleAction + '" data-id="' + task.id + '">' + toggleLabel + '</button>' +
          '<button type="button" class="btn btn-danger btn-delete" data-id="' +
            task.id + '">Delete</button>' +
        '</div>' +
      '</div>';

    return li;
  }

  function renderTasks(tasks) {
    taskList.textContent = '';
    if (!tasks || tasks.length === 0) {
      emptyState.hidden = false;
      listMeta.textContent = '';
      return;
    }

    emptyState.hidden = true;
    var completed = tasks.filter(function (task) {
      return task.status === 'completed';
    }).length;
    listMeta.textContent =
      tasks.length + ' task' + (tasks.length === 1 ? '' : 's') +
      ' \u00b7 ' + completed + ' completed';

    var fragment = document.createDocumentFragment();
    tasks.forEach(function (task) {
      fragment.appendChild(renderTask(task));
    });
    taskList.appendChild(fragment);
  }

  /**
   * Fetch the list from the API and render it (FR-02).
   * Returns true when the refresh succeeded, false when it failed (the error
   * is already displayed in the status region).
   */
  async function loadTasks() {
    try {
      var tasks = await api(API_BASE);
      clearStatus();
      renderTasks(tasks);
      return true;
    } catch (err) {
      showStatus(err.message, 'error');
      renderTasks([]);
      return false;
    }
  }

  /** Disable a button while an in-flight mutation runs (prevents double-send). */
  async function withBusy(button, fn) {
    button.disabled = true;
    try {
      await fn();
    } finally {
      button.disabled = false;
    }
  }

  /** Create form submit: POST /api/tasks, then reload the list (FR-01). */
  form.addEventListener('submit', function (event) {
    event.preventDefault();

    var title = TITLE_INPUT.value.trim();
    var description = DESCRIPTION_INPUT.value.trim();
    var notifyEmail = EMAIL_INPUT.value.trim();

    if (!title) {
      showStatus('Title is required.', 'error');
      TITLE_INPUT.focus();
      return;
    }
    if (!notifyEmail) {
      showStatus('Notify email is required.', 'error');
      EMAIL_INPUT.focus();
      return;
    }

    withBusy(createBtn, async function () {
      try {
        var task = await api(API_BASE, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: title, description: description, notify_email: notifyEmail }),
        });
        form.reset();
        // Re-render first, then announce: loadTasks() clears the status region,
        // so the confirmation must be set after the fresh GET completes.
        var reloaded = await loadTasks();
        if (reloaded) {
          showStatus('Task "' + task.title + '" created.', 'success');
        }
      } catch (err) {
        showStatus(err.message, 'error');
      }
    });
  });

  /** List actions via event delegation: Complete/Reopen and Delete. */
  taskList.addEventListener('click', function (event) {
    var button = event.target.closest('button[data-id]');
    if (!button) {
      return;
    }

    var id = button.dataset.id;

    if (button.classList.contains('btn-delete')) {
      // DELETE /api/tasks/:id (FR-07)
      withBusy(button, async function () {
        try {
          await api(API_BASE + '/' + id, { method: 'DELETE' });
          var reloaded = await loadTasks();
          if (reloaded) {
            showStatus('Task deleted.', 'success');
          }
        } catch (err) {
          showStatus(err.message, 'error');
        }
      });
      return;
    }

    // Complete/Reopen: PATCH /api/tasks/:id with a status body (FR-05, FR-06).
    var action = button.dataset.action;
    var nextStatus = action === 'reopen' ? 'pending' : 'completed';
    withBusy(button, async function () {
      try {
        await api(API_BASE + '/' + id, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: nextStatus }),
        });
        // Re-render first, then announce (loadTasks() clears the status region).
        var reloaded = await loadTasks();
        if (reloaded) {
          showStatus(
            nextStatus === 'completed' ? 'Task completed.' : 'Task reopened.',
            'success'
          );
        }
      } catch (err) {
        showStatus(err.message, 'error');
      }
    });
  });

  // Initial load (FR-02 / FR-15).
  loadTasks();
})();
