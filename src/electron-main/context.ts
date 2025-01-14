import logger from "electron-log";
import path from "path";
import {Deferred} from "ts-deferred";
import {ReplaySubject, merge} from "rxjs";
import {Fs as StoreFs, Model as StoreModel, Store} from "fs-json-store";
import {app} from "electron";
import {distinctUntilChanged, take} from "rxjs/operators";

import {Config, Settings} from "src/shared/model/options";
import {Context, ContextInitOptions, ContextInitOptionsPaths} from "./model";
import {Database} from "./database";
import {ElectronContextLocations} from "src/shared/model/electron";
import {INITIAL_STORES, configEncryptionPresetValidator, settingsAccountLoginUniquenessValidator} from "./constants";
import {LOCAL_WEBCLIENT_PROTOCOL_PREFIX, RUNTIME_ENV_E2E, RUNTIME_ENV_USER_DATA_DIR, WEB_CHUNK_NAMES} from "src/shared/constants";
import {formatFileUrl} from "./util";

export function initContext(options: ContextInitOptions = {}): Context {
    const storeFs = options.storeFs
        ? options.storeFs
        : StoreFs.Fs.volume({
            writeFileAtomicOptions: {
                fsync: false,
                disableChmod: true,
                disableChown: true,
            },
            fsNoEpermAnymore: {
                items: [
                    {
                        platforms: ["win32"],
                        errorCodes: ["EPERM", "EBUSY"],
                        options: {
                            retryIntervalMs: 100, // every 100 ms
                            retryTimeoutMs: 5 * 1000, // 5 seconds
                        },
                    },
                ],
            },
        });
    const locations = initLocations(storeFs, options.paths);

    logger.transports.file.file = path.join(locations.userDataDir, "log.log");
    logger.transports.file.maxSize = 1024 * 1024 * 50; // 50MB
    logger.transports.file.level = false;
    logger.transports.console.level = false;

    const {
        config$,
        configStore,
    } = (() => {
        const store = new Store<Config>({
            fs: storeFs,
            optimisticLocking: true,
            file: path.join(locations.userDataDir, "config.json"),
            validators: [configEncryptionPresetValidator],
            serialize: (data) => Buffer.from(JSON.stringify(data, null, 2)),
        });
        const subject$ = new ReplaySubject<Config>(1);

        store.read = ((read) => {
            const result: typeof store.read = async (...args) => {
                const config = await read(...args);
                if (config) {
                    subject$.next(config);
                }
                return config;
            };
            return result;
        })(store.read.bind(store));

        store.write = ((write) => {
            const result: typeof store.write = async (...args) => {
                const config = await write(...args);
                subject$.next(config);
                return config;
            };
            return result;
        })(store.write.bind(store));

        return {
            config$: merge(
                subject$.asObservable().pipe(
                    take(1),
                ),
                subject$.asObservable().pipe(
                    distinctUntilChanged(({_rev: prev}, {_rev: curr}) => curr === prev),
                ),
            ),
            configStore: store,
        };
    })();

    const ctx: Context = {
        storeFs,
        locations,
        runtimeEnvironment: Boolean(process.env[RUNTIME_ENV_E2E])
            ? "e2e"
            : "production",
        deferredEndpoints: new Deferred(),
        ...(() => {
            const encryption = {
                async keyResolver() {
                    const {databaseEncryptionKey} = await ctx.settingsStore.readExisting();
                    return databaseEncryptionKey;
                },
                async presetResolver() {
                    return {encryption: {type: "sodium.crypto_secretbox_easy", preset: "algorithm:default"}} as const;
                },
            } as const;
            return {
                db: new Database(
                    {
                        file: path.join(locations.userDataDir, "database.bin"),
                        encryption,
                    },
                    storeFs,
                ),
                sessionDb: new Database(
                    {
                        file: path.join(locations.userDataDir, "database-session.bin"),
                        encryption,
                    },
                    storeFs,
                ),
            };
        })(),
        initialStores: options.initialStores || {config: INITIAL_STORES.config(), settings: INITIAL_STORES.settings()},
        config$,
        configStore,
        settingsStore: new Store<Settings>({
            fs: storeFs,
            optimisticLocking: true,
            file: path.join(locations.userDataDir, "settings.bin"),
            validators: [settingsAccountLoginUniquenessValidator],
        }),
        keytarSupport: true,
        getSpellCheckController: () => {
            throw new Error(`Spell check controller has net been initialized yet`);
        },
    };

    return ctx;
}

function initLocations(
    storeFs: StoreModel.StoreFs,
    paths?: ContextInitOptionsPaths,
): ElectronContextLocations {
    const customUserDataDir = process.env[RUNTIME_ENV_USER_DATA_DIR];

    if (customUserDataDir && !directoryExists(customUserDataDir, storeFs)) {
        throw new Error(
            `Make sure that custom "userData" dir exists before passing the "${RUNTIME_ENV_USER_DATA_DIR}" environment variable`,
        );
    }

    const {appDir, userDataDir} = paths || {
        appDir: path.resolve(
            __dirname,
            BUILD_ENVIRONMENT === "development"
                ? "../app-dev"
                : "../app",
        ),
        userDataDir: customUserDataDir || app.getPath("userData"),
    };
    const appRelativePath = (...value: string[]) => path.join(appDir, ...value);
    const icon = appRelativePath("./assets/icons/icon.png");

    return {
        appDir,
        userDataDir,
        icon,
        trayIcon: icon,
        numbersFont: appRelativePath("./assets/numbers.ttf"),
        browserWindowPage: formatFileUrl(
            appRelativePath("./web/", WEB_CHUNK_NAMES["browser-window"], "index.html"),
        ),
        aboutBrowserWindowPage: appRelativePath("./web/", WEB_CHUNK_NAMES.about, "index.html"),
        searchInPageBrowserViewPage: appRelativePath("./web/", WEB_CHUNK_NAMES["search-in-page-browser-view"], "index.html"),
        preload: {
            aboutBrowserWindow: appRelativePath("./electron-preload/about.js"),
            browserWindow: appRelativePath("./electron-preload/browser-window.js"),
            browserWindowE2E: appRelativePath("./electron-preload/browser-window-e2e.js"),
            searchInPageBrowserView: appRelativePath("./electron-preload/search-in-page-browser-view.js"),
            fullTextSearchBrowserWindow: appRelativePath("./electron-preload/database-indexer.js"),
            webView: {
                protonmail: formatFileUrl(appRelativePath("./electron-preload/webview/protonmail.js")),
                tutanota: formatFileUrl(appRelativePath("./electron-preload/webview/tutanota.js")),
            },
        },
        vendorsAppCssLinkHref: (() => {
            const file = appRelativePath("./web/browser-window/vendor.css");
            const stat = storeFs._impl.statSync(file);
            if (!stat.isFile()) {
                throw new Error(`Location "${file}" exists but it's not a file`);
            }
            return formatFileUrl(file);
        })(),
        ...(() => {
            const {protocolBundles, webClients}: Pick<ElectronContextLocations, "webClients">
                & { protocolBundles: Array<{ scheme: string; directory: string }> } = {
                protocolBundles: [],
                webClients: {
                    protonmail: [],
                    tutanota: [],
                },
            };

            let schemeIndex = 0;

            for (const [accountType, items] of Object.entries(webClients)) {
                const webClientsDir = appRelativePath("webclient", accountType);

                for (const dirName of listDirsNames(storeFs, webClientsDir)) {
                    const directory = path.resolve(webClientsDir, dirName);
                    const scheme = `${LOCAL_WEBCLIENT_PROTOCOL_PREFIX}${schemeIndex++}`;

                    items.push({
                        entryUrl: `${scheme}://${dirName}`,
                        entryApiUrl: `https://${dirName}`,
                    });

                    protocolBundles.push({
                        scheme,
                        directory,
                    });
                }
            }

            return {protocolBundles, webClients};
        })(),
    };
}

function listDirsNames(storeFs: StoreModel.StoreFs, dir: string): string[] {
    const result: string[] = [];
    if (!(exists(dir, storeFs))) {
        return result;
    }
    const files: string[] = storeFs._impl.readdirSync(dir);
    for (const dirName of files) {
        const dirPath = path.join(dir, dirName);
        if (directoryExists(dirPath, storeFs)) {
            result.push(dirName);
        }
    }
    return result;
}

function exists(file: string, storeFs: StoreModel.StoreFs): boolean {
    try {
        storeFs._impl.statSync(file);
    } catch (error) {
        if (error.code === "ENOENT") {
            return false;
        }

        throw error;
    }

    return true;
}

function directoryExists(file: string, storeFs: StoreModel.StoreFs = StoreFs.Fs.fs): boolean {
    if (!(exists(file, storeFs))) {
        return false;
    }

    const stat = storeFs._impl.statSync(file);

    return stat.isDirectory;
}
