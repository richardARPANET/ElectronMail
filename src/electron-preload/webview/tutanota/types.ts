import * as Rest from "src/electron-preload/webview/tutanota/lib/rest";

export interface TutanotaWindow {
    SystemJS: SystemJSLoader.System;
    tutao?: {
        m: {
            route: import("mithril").Route;
        };
        logins?: {
            getUserController?: () => { accessToken: string, user: Rest.Model.User };
        };
    };
}
