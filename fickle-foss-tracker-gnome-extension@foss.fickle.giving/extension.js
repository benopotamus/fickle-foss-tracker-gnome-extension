import { Extension, gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
import Gio from 'gi://Gio';
import GioUnix from 'gi://GioUnix';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import GdkPixbuf from 'gi://GdkPixbuf';
import St from 'gi://St';

Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async', 'communicate_utf8_finish');

// See https://api.pygobject.gnome.org/GLib-2.0/structure-VariantType.html#gvariant-type-strings for arg type format
const DBUS_SCHEMA = `
<node>
	<interface name="org.gnome.shell.extensions.FickleFossTracker1">
		<method name="GetAppIcons">
			<arg type="as" direction="in" name="desktop_file_names">
				<doc:doc><doc:summary>An array of desktop file names (aka app_id+'.desktop') for which icons will be returned. E.g. ["giving.fickle.foss.desktop", ...]</doc:summary></doc:doc>
			</arg>
			<arg type="a{sa{say}}" direction="out" name="icons">
				<doc:doc><doc:summary>A dictionary of apps, containing a dictionary of icons for that app. The inner dictionary is a mapping of icon sizes to byte arrays.</doc:summary></doc:doc>
			</arg>
		</method>
	</interface>
</node>`;

export default class FickleFossTracker extends Extension {

	/***
	 * Expects an array of desktop file names - e.g. ["giving.fickle.foss.desktop", ...]
	 * Returns a dictionary of desktop file names and icons.
	 * 
	 * Can be tested in a terminal with the following command:
	 * 		gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/shell/extensions/FickleFossTracker1 --method org.gnome.shell.extensions.FickleFossTracker1.GetAppIcons "['giving.fickle.foss.desktop']"
	 */
	GetAppIcons(desktop_file_names) {
		let response = {};
		const theme = new St.IconTheme();

		for (const desktop_filename of desktop_file_names) {
			console.log(desktop_filename);
			const appInfo = GioUnix.DesktopAppInfo.new(desktop_filename);
			try {
				const themedIcon = appInfo.get_icon(); // Returns a Gio.ThemedIcon

				const iconInfo64 = theme.lookup_by_gicon(themedIcon, 64, 0);
				const iconInfo96 = theme.lookup_by_gicon(themedIcon, 96, 0);

				const iconFilename64 = iconInfo64.get_filename();
				const iconFilename96 = iconInfo96.get_filename();

				const pixbuf64 = GdkPixbuf.Pixbuf.new_from_file_at_size(iconFilename64, 64, 64);
				const pixbuf96 = GdkPixbuf.Pixbuf.new_from_file_at_size(iconFilename96, 96, 96);

				const [ok64, buffer64] = pixbuf64.save_to_bufferv('png', [], []); // buffer is a ByteArray
				const [ok96, buffer96] = pixbuf96.save_to_bufferv('png', [], []); // buffer is a ByteArray

				response[desktop_filename] = {
					size64: ok64 ? buffer64 : null,
					size96: ok96 ? buffer96 : null,
				};
			} catch (e) {
				/* We won't be able to get the icon bytes for reasons like, e.g. an app in fickle-foss.db has been uninstalled, and it's desktop file no longer exists.
				 * We don't log the error to the system journal because it's not really an error. Certainly not something a user should try to resolve.
				 * We return null so Fickle FOSS still has a lookup dictionary of desktop filenames, and it can test whether the value is null and provide a fallback icon if so.
				 */
				console.log(`FickleFossTracker extension [GetAppIcons]: ${e}`);
				response[desktop_filename] = {
					size64: null,
					size96: null,
				}
			}
		}
		return response;
	}

	appSystem = null;
	appStateChangedConnection = null;
	dbFile = null;

	/* We keep a record of dates and apps used.
	 * This record is checked before inserting a new record into the database. I didn't test it but presumably this is faster for ignoring duplicate entries than relying on the IGNORE part of the SQL statement (logApp).
	 * Structure is: { date: [app id's] }
	 */ 
	appsUsed = {};

	async enable() {
		console.log('FickleFossTracker enabled! 💪')

		await this.initdb();
		
		this.appSystem = Shell.AppSystem.get_default();
		this.appStateChangedConnection = this.appSystem.connect("app-state-changed", (_, app) => {
			if (app.state == Shell.AppState.STARTING) {
				this.logApp(app.get_id(), app.get_name());
			}
		})

		this.dbus = Gio.DBusExportedObject.wrapJSObject(DBUS_SCHEMA, this);
		this.dbus.export(
			Gio.DBus.session,
			"/org/gnome/shell/extensions/FickleFossTracker1"
		);
	}

	disable() {
		this.appSystem.disconnect(this.appStateChangedConnection);
		this.appSystem = null;

		this.dbus.flush();
		this.dbus.unexport();
		delete this.dbus;
	}

	async logApp(app_id, app_name) {
		/***
		 * Adds a record to the database that the app was run today.
		 * 
		 * This is called each time the "app-state-changed" signal is fired.
		 */
		console.info('FickleFossTracker extension [logApp]: Logging an app');
		let date = Temporal.Now.plainDateISO();

		// Skip logging if an entry already exists for this app on this date
		if (this.appsUsed[date]?.includes(app_id)) return;

		const proc = Gio.Subprocess.new(
			['sqlite3', this.dbFile.get_path(), `
				PRAGMA foreign_keys = ON;
				INSERT OR IGNORE INTO Apps (name, desktop_file) VALUES ('${app_name}', '${app_id}');
				INSERT OR IGNORE INTO DatesRun (date, app_id) SELECT '${date}', id FROM Apps WHERE desktop_file = '${app_id}';
			`],
			Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
		);

		try {
			const [ok, stdout_buf, stderr_buf] = await proc.communicate_utf8_async(null, null);
			if (!proc.get_successful()) {
				console.error(`FickleFossTracker extension [logApp:sqlite3 subprocess]: ${stderr_buf}`);
				return;
			}
			if (!this.appsUsed[date]) this.appsUsed[date] = [];
			this.appsUsed[date].push(app_id);
			console.info('FickleFossTracker extension [logApp]: App logged');
		} catch (e) {
			console.error(`FickleFossTracker extension [logApp]: ${e}`);
		}
	}

	async initdb() {
		/***
		 * Sets up database. Ensures db file exists and has tables.
		 */

		const dbDirPath = GLib.get_home_dir() + "/.local/share/fickle-foss/";
		const dbFilePath = dbDirPath + 'fickle-foss.db'

		// Create any missing directories as required. 
		GLib.mkdir_with_parents(dbDirPath, 0o755);
		
		// Get Gio file reference
		this.dbFile = Gio.File.new_for_path(dbFilePath);

		// Create db file is doesn't exist - and silently catch GLib error if it does.
		try {
			this.dbFile.create(Gio.FileCreateFlags.NONE, null);
		} catch (e) {
			// See https://docs.gtk.org/glib/struct.Error.html
			// And https://gjs-docs.gnome.org/gio20/gio.ioerrorenum#default-exists
			if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS)) throw e;
		}

		const proc = Gio.Subprocess.new(
			['sqlite3', this.dbFile.get_path(), `
				PRAGMA foreign_keys = ON;

				CREATE TABLE IF NOT EXISTS Apps (
					id				INTEGER PRIMARY KEY AUTOINCREMENT,
					name			TEXT	NOT NULL,
					desktop_file	TEXT	NOT NULL UNIQUE
				);

				CREATE TABLE IF NOT EXISTS DatesRun (
					id		INTEGER PRIMARY KEY AUTOINCREMENT,
					date	TEXT	NOT NULL,
					app_id	INTEGER NOT NULL,
					FOREIGN KEY (app_id) REFERENCES Apps(id),
					UNIQUE (date, app_id)
				);

				CREATE TABLE IF NOT EXISTS Donations (
					id		INTEGER PRIMARY KEY AUTOINCREMENT,
					date	TEXT	NOT NULL,
					amount	INTEGER	NOT NULL,
					app_id	INTEGER NOT NULL,
					FOREIGN KEY (app_id) REFERENCES Apps(id)
				);
			`],

			// The flags control what I/O pipes are opened and how they are directed
			Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
		);

		try {
			const [ok, stdout_buf, stderr] = await proc.communicate_utf8_async(null, null);
			if (!proc.get_successful()) {
				console.error(`FickleFossTracker extension [initdb]: ${stderr}`);
				return;
			}
			console.info('FickleFossTracker extension [initdb]: Complete');
		} catch (e) {
			console.error(`FickleFossTracker extension [initdb]: ${e}`);
		}

	}
}