import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (specifier.startsWith(".") && !/\.[a-z]+$/i.test(specifier)) {
        return nextResolve(`${specifier}.ts`, context);
      }
      throw error;
    }
  },
});

test("failed SQLite removals are reconciled on the next launch", async () => {
  const originalWindow = globalThis.window;
  const originalLocalStorage = globalThis.localStorage;
  const values = new Map();
  const database = new Map();
  let failRemove = false;
  let failSet = false;
  let holdRemove = false;
  let removeStarted;
  let releaseRemove;

  globalThis.window = {};
  globalThis.localStorage = {
    getItem(key) {
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
    removeItem(key) {
      values.delete(key);
    },
  };

  mockIPC((command, payload) => {
    const key = payload?.key;
    if (command === "kv_get") return database.get(key) ?? null;
    if (command === "kv_set") {
      if (failSet) throw new Error("database unavailable");
      database.set(key, payload?.value);
      return null;
    }
    if (command === "kv_remove") {
      if (failRemove) throw new Error("database unavailable");
      if (holdRemove) {
        return new Promise((resolve) => {
          removeStarted?.();
          releaseRemove = () => {
            database.delete(key);
            resolve(null);
          };
        });
      }
      database.delete(key);
      return null;
    }
    return null;
  });

  try {
    const firstLaunch = await import(`../../src/store.ts?first=${Date.now()}`);
    await firstLaunch.hydrateStore();
    const activeKey = "grok-active-v1";
    firstLaunch.saveActiveId("thread-old");
    await firstLaunch.flushStore();
    assert.equal(database.get(activeKey), "thread-old");

    failRemove = true;
    firstLaunch.saveActiveId(null);
    await firstLaunch.flushStore();
    assert.equal(database.get(activeKey), "thread-old");
    assert.equal(JSON.parse(values.get(activeKey)).state, "pending-remove");

    failRemove = false;
    const secondLaunch = await import(`../../src/store.ts?second=${Date.now()}`);
    await secondLaunch.hydrateStore();

    assert.equal(database.has(activeKey), false);
    assert.equal(values.has(activeKey), false);

    secondLaunch.saveActiveId("thread-current");
    await secondLaunch.flushStore();

    const removeHasStarted = new Promise((resolve) => {
      removeStarted = resolve;
    });
    holdRemove = true;
    secondLaunch.saveActiveId(null);
    await removeHasStarted;
    secondLaunch.saveActiveId("thread-next");
    failSet = true;
    releaseRemove();
    await secondLaunch.flushStore();

    const pendingSet = JSON.parse(values.get(activeKey));
    assert.equal(pendingSet.state, "pending-set");
    assert.equal(pendingSet.value, "thread-next");
    assert.equal(database.has(activeKey), false);

    failSet = false;
    holdRemove = false;
    const thirdLaunch = await import(`../../src/store.ts?third=${Date.now()}`);
    await thirdLaunch.hydrateStore();

    assert.equal(database.get(activeKey), "thread-next");
    assert.equal(JSON.parse(values.get(activeKey)).state, "cache");
  } finally {
    clearMocks();
    if (originalWindow === undefined) {
      Reflect.deleteProperty(globalThis, "window");
    } else {
      globalThis.window = originalWindow;
    }
    if (originalLocalStorage === undefined) {
      Reflect.deleteProperty(globalThis, "localStorage");
    } else {
      globalThis.localStorage = originalLocalStorage;
    }
  }
});

const STORE_KEYS = {
  projects: "grok-projects-v1",
  threads: "grok-threads-v1",
  active: "grok-active-v1",
  prefs: "grok-prefs-v1",
};

const DEFAULT_PREFS = {
  modelId: "gpt-5.2",
  thinking: "medium",
  openaiFastMode: false,
  accessMode: "workspace",
  permissionMode: "auto",
  agentMode: "build",
  sidebarOpen: true,
  activeProjectId: null,
  collapseThinking: false,
  notifyOnAgentComplete: true,
  notifyOnAgentError: true,
};

async function withMockedTauriStore(run) {
  const originalWindow = globalThis.window;
  const originalLocalStorage = globalThis.localStorage;
  const values = new Map();
  const database = new Map();

  globalThis.window = {};
  globalThis.localStorage = {
    getItem(key) {
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
    removeItem(key) {
      values.delete(key);
    },
  };

  try {
    await run({ values, database });
  } finally {
    clearMocks();
    if (originalWindow === undefined) {
      Reflect.deleteProperty(globalThis, "window");
    } else {
      globalThis.window = originalWindow;
    }
    if (originalLocalStorage === undefined) {
      Reflect.deleteProperty(globalThis, "localStorage");
    } else {
      globalThis.localStorage = originalLocalStorage;
    }
  }
}

test("a staged set survives the split-marker failure sequence", async () => {
  await withMockedTauriStore(async ({ values, database }) => {
    database.set(STORE_KEYS.active, "thread-old");
    let failSqliteSet = false;
    let rejectSplitMarker = false;

    const baseSetItem = globalThis.localStorage.setItem;
    globalThis.localStorage.setItem = (key, value) => {
      if (rejectSplitMarker && key.endsWith(":pending-sqlite")) {
        throw new Error("marker write failed");
      }
      baseSetItem.call(globalThis.localStorage, key, value);
    };

    mockIPC((command, payload) => {
      const key = payload?.key;
      if (command === "kv_get") return database.get(key) ?? null;
      if (command === "kv_set") {
        if (failSqliteSet) throw new Error("database unavailable");
        database.set(key, payload?.value);
        return null;
      }
      if (command === "kv_remove") {
        database.delete(key);
        return null;
      }
      return null;
    });

    const firstLaunch = await import(`../../src/store.ts?atomic-first=${Date.now()}`);
    await firstLaunch.hydrateStore();

    rejectSplitMarker = true;
    failSqliteSet = true;
    firstLaunch.saveActiveId("thread-new");
    await firstLaunch.flushStore();
    assert.equal(database.get(STORE_KEYS.active), "thread-old");
    assert.equal(values.has(`${STORE_KEYS.active}:pending-sqlite`), false);

    rejectSplitMarker = false;
    failSqliteSet = false;
    const secondLaunch = await import(`../../src/store.ts?atomic-second=${Date.now()}`);
    await secondLaunch.hydrateStore();

    assert.equal(database.get(STORE_KEYS.active), "thread-new");
  });
});

test("SQLite stays authoritative when newer local staging fails", async () => {
  await withMockedTauriStore(async ({ values, database }) => {
    let failLocalSet = false;
    let failSqliteSet = false;
    const baseSetItem = globalThis.localStorage.setItem;
    globalThis.localStorage.setItem = (key, value) => {
      if (failLocalSet && key === STORE_KEYS.active) {
        throw new Error("local staging unavailable");
      }
      baseSetItem.call(globalThis.localStorage, key, value);
    };

    mockIPC((command, payload) => {
      const key = payload?.key;
      if (command === "kv_get") return database.get(key) ?? null;
      if (command === "kv_set") {
        if (failSqliteSet) throw new Error("database unavailable");
        database.set(key, payload?.value);
        return null;
      }
      if (command === "kv_remove") {
        database.delete(key);
        return null;
      }
      return null;
    });

    const firstLaunch = await import(`../../src/store.ts?local-fail=${Date.now()}`);
    await firstLaunch.hydrateStore();

    failSqliteSet = true;
    firstLaunch.saveActiveId("thread-old-intent");
    await firstLaunch.flushStore();
    assert.equal(
      JSON.parse(values.get(STORE_KEYS.active)).value,
      "thread-old-intent",
    );

    failSqliteSet = false;
    failLocalSet = true;
    firstLaunch.saveActiveId("thread-sqlite");
    await firstLaunch.flushStore();

    assert.equal(database.get(STORE_KEYS.active), "thread-sqlite");
    assert.equal(values.has(STORE_KEYS.active), false);

    failLocalSet = false;
    const secondLaunch = await import(`../../src/store.ts?local-fail-restart=${Date.now()}`);
    await secondLaunch.hydrateStore();
    assert.equal(database.get(STORE_KEYS.active), "thread-sqlite");
    assert.equal(JSON.parse(values.get(STORE_KEYS.active)).value, "thread-sqlite");
  });
});

test("a transient SQLite read cannot unlock a stale cached write", async () => {
  await withMockedTauriStore(async ({ values, database }) => {
    const sqlitePrefs = JSON.stringify({ sidebarOpen: false });
    database.set(STORE_KEYS.prefs, sqlitePrefs);
    values.set(
      STORE_KEYS.prefs,
      JSON.stringify({
        version: 1,
        revision: "stale-cache",
        state: "cache",
        value: JSON.stringify(DEFAULT_PREFS),
      }),
    );

    let prefsReads = 0;
    let firstReadStarted;
    let rejectFirstRead;
    const readStarted = new Promise((resolve) => {
      firstReadStarted = resolve;
    });

    mockIPC((command, payload) => {
      const key = payload?.key;
      if (command === "kv_get") {
        if (key === STORE_KEYS.prefs && prefsReads++ === 0) {
          firstReadStarted();
          return new Promise((_, reject) => {
            rejectFirstRead = () => reject(new Error("transient read failure"));
          });
        }
        return database.get(key) ?? null;
      }
      if (command === "kv_set") {
        database.set(key, payload?.value);
        return null;
      }
      if (command === "kv_remove") {
        database.delete(key);
        return null;
      }
      return null;
    });

    const store = await import(`../../src/store.ts?transient=${Date.now()}`);
    const hydration = store.hydrateStore();
    await readStarted;

    store.savePrefs(DEFAULT_PREFS);
    await store.flushStore();
    assert.equal(database.get(STORE_KEYS.prefs), sqlitePrefs);

    rejectFirstRead();
    await hydration;

    assert.ok(prefsReads >= 2);
    assert.equal(store.loadPrefs().sidebarOpen, false);
    assert.equal(database.get(STORE_KEYS.prefs), sqlitePrefs);
  });
});

test("unknown local cache state keeps SQLite hydration closed until retry", async () => {
  await withMockedTauriStore(async ({ values, database }) => {
    const pendingThreads = JSON.stringify([
      {
        id: "pending-thread",
        title: "Pending thread",
        projectId: "db-project",
        messages: [],
        createdAt: 2,
        updatedAt: 2,
      },
    ]);
    database.set(
      STORE_KEYS.projects,
      JSON.stringify([{ id: "db-project", name: "Database", path: "C:/db" }]),
    );
    database.set(
      STORE_KEYS.threads,
      JSON.stringify([
        {
          id: "db-thread",
          title: "Database thread",
          projectId: "db-project",
          messages: [],
          createdAt: 1,
          updatedAt: 1,
        },
      ]),
    );
    database.set(STORE_KEYS.active, "db-thread");
    database.set(STORE_KEYS.prefs, JSON.stringify({ sidebarOpen: false }));
    values.set(
      STORE_KEYS.threads,
      JSON.stringify({
        version: 1,
        revision: "pending-newer",
        state: "pending-set",
        value: pendingThreads,
      }),
    );
    const baseGetItem = globalThis.localStorage.getItem;
    let failThreadRead = true;
    globalThis.localStorage.getItem = (key) => {
      if (key === STORE_KEYS.threads && failThreadRead) {
        throw new Error("local cache unavailable");
      }
      return baseGetItem.call(globalThis.localStorage, key);
    };

    mockIPC((command, payload) => {
      const key = payload?.key;
      if (command === "kv_get") return database.get(key) ?? null;
      if (command === "kv_set") {
        database.set(key, payload?.value);
        return null;
      }
      return null;
    });

    const store = await import(`../../src/store.ts?cache-read=${Date.now()}`);
    await assert.rejects(store.hydrateStore(), /local cache unavailable/);
    assert.equal(store.isStoreHydrated(), false);
    assert.equal(database.get(STORE_KEYS.threads).includes("db-thread"), true);

    failThreadRead = false;
    await store.hydrateStore();

    assert.equal(store.isStoreHydrated(), true);
    assert.equal(store.loadProjects()[0]?.id, "db-project");
    assert.equal(store.loadThreads()[0]?.id, "pending-thread");
    assert.equal(database.get(STORE_KEYS.threads), pendingThreads);
    assert.equal(store.loadPrefs().sidebarOpen, false);
  });
});

test("one unknown key keeps every save path gated until hydration retries", async () => {
  await withMockedTauriStore(async ({ values, database }) => {
    database.set(
      STORE_KEYS.threads,
      JSON.stringify([
        {
          id: "db-thread",
          title: "Database thread",
          projectId: null,
          messages: [],
          createdAt: 1,
          updatedAt: 1,
        },
      ]),
    );
    database.set(
      STORE_KEYS.projects,
      JSON.stringify([{ id: "db-project", name: "Database", path: "C:/db" }]),
    );
    database.set(STORE_KEYS.prefs, JSON.stringify({ sidebarOpen: false }));
    database.set(STORE_KEYS.active, "db-thread");

    let failPrefsRead = true;
    const mutations = [];
    mockIPC((command, payload) => {
      const key = payload?.key;
      if (command === "kv_get") {
        if (key === STORE_KEYS.prefs && failPrefsRead) {
          throw new Error("database unavailable");
        }
        return database.get(key) ?? null;
      }
      if (command === "kv_set") {
        mutations.push([command, key, payload?.value]);
        database.set(key, payload?.value);
        return null;
      }
      if (command === "kv_remove") {
        mutations.push([command, key]);
        database.delete(key);
        return null;
      }
      return null;
    });

    const store = await import(`../../src/store.ts?partial=${Date.now()}`);
    await assert.rejects(store.hydrateStore());
    const localAfterFailure = new Map(values);
    mutations.length = 0;

    store.savePrefs(DEFAULT_PREFS);
    store.saveProjects([{ id: "new-project", name: "New", path: "C:/new" }]);
    store.saveActiveId("new-thread");
    assert.equal(store.saveThreads([], { immediate: true }), "failed");
    await store.flushStore();

    assert.deepEqual(mutations, []);
    assert.deepEqual(values, localAfterFailure);

    failPrefsRead = false;
    await store.hydrateStore();
    const threads = store.loadThreads();
    assert.equal(threads[0]?.id, "db-thread");
    assert.equal(store.loadProjects()[0]?.id, "db-project");
    assert.equal(store.loadPrefs().sidebarOpen, false);
    assert.equal(store.loadActiveId(threads, null), "db-thread");
  });
});

test("thread save completion reports when every durable write fails", async () => {
  await withMockedTauriStore(async () => {
    globalThis.localStorage.setItem = () => {
      throw new Error("quota exceeded");
    };

    let sqliteSetAttempts = 0;
    let sqliteAvailable = false;
    mockIPC((command) => {
      if (command === "kv_get") return null;
      if (command === "kv_set") {
        sqliteSetAttempts += 1;
        if (!sqliteAvailable) throw new Error("database unavailable");
        return null;
      }
      return null;
    });

    const store = await import(`../../src/store.ts?save-result=${Date.now()}`);
    await store.hydrateStore();
    const completions = [];
    const unsubscribe = store.subscribeThreadsSaveResults((result) => {
      completions.push(result);
    });

    try {
      const scheduled = store.saveThreads(
        [
          {
            id: "unsaved-thread",
            title: "Unsaved",
            projectId: null,
            messages: [],
            createdAt: 1,
            updatedAt: 1,
          },
        ],
        { immediate: true },
      );

      assert.equal(scheduled, "ok");
      assert.equal(await store.flushStore(), "failed");
      assert.equal(sqliteSetAttempts, 2);
      assert.deepEqual(completions, ["failed"]);

      sqliteAvailable = true;
      assert.equal(await store.flushStore(), "ok");
      assert.equal(sqliteSetAttempts, 3);
      assert.deepEqual(completions, ["failed", "ok"]);
    } finally {
      unsubscribe();
    }
  });
});

test("flush reports and retries project writes when every durable store fails", async () => {
  await withMockedTauriStore(async ({ database }) => {
    const originalSetItem = globalThis.localStorage.setItem;
    let rejectLocalProjectWrites = false;
    let sqliteAvailable = false;
    let sqliteSetAttempts = 0;

    globalThis.localStorage.setItem = (key, value) => {
      if (rejectLocalProjectWrites && key === STORE_KEYS.projects) {
        throw new Error("quota exceeded");
      }
      originalSetItem.call(globalThis.localStorage, key, value);
    };

    mockIPC((command, payload) => {
      const key = payload?.key;
      if (command === "kv_get") return database.get(key) ?? null;
      if (command === "kv_set") {
        sqliteSetAttempts += 1;
        if (!sqliteAvailable) throw new Error("database unavailable");
        database.set(key, payload?.value);
        return null;
      }
      return null;
    });

    const store = await import(`../../src/store.ts?project-flush=${Date.now()}`);
    await store.hydrateStore();
    rejectLocalProjectWrites = true;
    store.saveProjects([
      { id: "project-new", name: "New", path: "C:/new" },
    ]);

    assert.equal(await store.flushStore(), "failed");
    assert.equal(database.has(STORE_KEYS.projects), false);
    const failedAttempts = sqliteSetAttempts;

    sqliteAvailable = true;
    assert.equal(await store.flushStore(), "ok");
    assert.ok(sqliteSetAttempts > failedAttempts);
    assert.deepEqual(JSON.parse(database.get(STORE_KEYS.projects)), [
      { id: "project-new", name: "New", path: "C:/new" },
    ]);
  });
});

test("a failed project write can recover through local storage alone", async () => {
  await withMockedTauriStore(async ({ values }) => {
    const originalSetItem = globalThis.localStorage.setItem;
    let localAvailable = false;

    globalThis.localStorage.setItem = (key, value) => {
      if (!localAvailable && key === STORE_KEYS.projects) {
        throw new Error("quota exceeded");
      }
      originalSetItem.call(globalThis.localStorage, key, value);
    };

    mockIPC((command) => {
      if (command === "kv_get") return null;
      if (command === "kv_set") throw new Error("database unavailable");
      return null;
    });

    const store = await import(`../../src/store.ts?project-local-retry=${Date.now()}`);
    await store.hydrateStore();
    store.saveProjects([
      { id: "project-local", name: "Local", path: "C:/local" },
    ]);
    assert.equal(await store.flushStore(), "failed");

    localAvailable = true;
    assert.equal(await store.flushStore(), "ok");
    const pending = JSON.parse(values.get(STORE_KEYS.projects));
    assert.equal(pending.state, "pending-set");
    assert.deepEqual(JSON.parse(pending.value), [
      { id: "project-local", name: "Local", path: "C:/local" },
    ]);
  });
});

test("malformed persisted records do not discard valid projects or threads", async () => {
  await withMockedTauriStore(async ({ values }) => {
    values.set(
      STORE_KEYS.projects,
      JSON.stringify({
        version: 1,
        revision: "malformed-projects",
        state: "cache",
        value: JSON.stringify([
          null,
          { id: "broken-project", name: null, path: 42 },
          {
            id: "project-ok",
            name: "Valid project",
            path: "C:/valid",
            createdAt: 10,
            updatedAt: 20,
          },
        ]),
      }),
    );
    values.set(
      STORE_KEYS.threads,
      JSON.stringify({
        version: 1,
        revision: "malformed-threads",
        state: "cache",
        value: JSON.stringify([
          null,
          { id: 42, title: "Broken", messages: [] },
          {
            id: "thread-ok",
            title: "Valid thread",
            projectId: "project-ok",
            createdAt: 10,
            updatedAt: 20,
            messages: [
              {
                id: "message-ok",
                role: "assistant",
                content: "still here",
                createdAt: 15,
                parts: { not: "an array" },
                toolCalls: "not an array",
              },
            ],
          },
        ]),
      }),
    );

    mockIPC((command, payload) => {
      if (command === "kv_get") return values.get(payload?.key) ?? null;
      return null;
    });

    const store = await import(`../../src/store.ts?malformed=${Date.now()}`);
    assert.deepEqual(
      store.loadProjects().map((project) => project.id),
      ["project-ok"],
    );

    const threads = store.loadThreads();
    assert.deepEqual(threads.map((thread) => thread.id), ["thread-ok"]);
    assert.equal(threads[0].messages[0].content, "still here");
    assert.equal(threads[0].messages[0].parts, undefined);
    assert.equal(threads[0].messages[0].toolCalls, undefined);
  });
});

test("threads whose persisted project is missing recover to Inbox", async () => {
  await withMockedTauriStore(async ({ values }) => {
    values.set(
      STORE_KEYS.projects,
      JSON.stringify({
        version: 1,
        revision: "projects",
        state: "cache",
        value: JSON.stringify([
          { id: "project-ok", name: "Valid project", path: "C:/valid" },
        ]),
      }),
    );
    values.set(
      STORE_KEYS.threads,
      JSON.stringify({
        version: 1,
        revision: "threads",
        state: "cache",
        value: JSON.stringify([
          {
            id: "thread-orphaned",
            title: "Orphaned thread",
            projectId: "project-missing",
            messages: [{ id: "message", role: "user", content: "keep me" }],
            createdAt: 1,
            updatedAt: 1,
          },
        ]),
      }),
    );

    mockIPC((command, payload) => {
      if (command === "kv_get") return values.get(payload?.key) ?? null;
      return null;
    });

    const store = await import(`../../src/store.ts?orphaned=${Date.now()}`);
    const [thread] = store.loadThreads();
    assert.equal(thread.id, "thread-orphaned");
    assert.equal(thread.projectId, null);
    assert.equal(thread.messages[0]?.content, "keep me");
  });
});
