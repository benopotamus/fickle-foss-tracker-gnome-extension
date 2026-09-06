import { Extension, gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
import Gio from 'gi://Gio';
import GioUnix from 'gi://GioUnix';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import St from 'gi://St';

Gio._promisify(Gio.File.prototype, 'copy_async', 'copy_finish');


export default class FickleFossTracker extends Extension {

	cancellable = null;
	app_system = null;
	app_state_changed_connection = null;
	icons_dir = GLib.get_home_dir() + "/.local/share/fickle-foss/icons";
	queue_dir_path = GLib.get_home_dir() + "/.local/share/fickle-foss/";
	queue_file_path = this.queue_dir_path + 'dbqueue'
	queue_file = null;

	/* We keep a record of dates and apps used.
	 * This record is checked before inserting a new record into the database. I didn't test it but presumably this is faster for ignoring duplicate entries than relying on the IGNORE part of the SQL statement (log_app).
	 * Structure is: { date: [app id's] }
	 */ 
	appsUsed = {};

	async enable() {
		console.log('FickleFossTracker enabled! 💪')
		this.cancellable = new Gio.Cancellable()
		await this.init_queue();

		// Ensure icons dirs exist. Create any missing directories as required. 
		// Conincidently creates the queue_dir_path as well.
		GLib.mkdir_with_parents(this.icons_dir + '/64/', 0o755);
		GLib.mkdir_with_parents(this.icons_dir + '/96/', 0o755);

		this.update_icon_cache().catch(logError);

		this.app_system = Shell.AppSystem.get_default();
		this.app_state_changed_connection = this.app_system.connect("app-state-changed", (_, app) => {
			if (app.state == Shell.AppState.STARTING) {
				this.log_app(app.get_id(), app.get_name());
			}
		})
	}

	disable() {
		this.app_system.disconnect(this.app_state_changed_connection);
		this.app_system = null;
		this.cancellable.cancel();
		this.cancellable = null;
	}

	/***
	 * Copies icon files to a directory where Flatpak Fickle FOSS can see it.
	 * 
	 * Files are stored in an "icons" directory. If files are svg's, they are stored in that directory. If files are anything itself (presumably a raster image format) they are stored in "64" and "96" subdirectories. The numbers represent pixel size.
	 */
	async update_icon_cache() {
		const theme = new St.IconTheme();
		const app_infos = Gio.AppInfo.get_all();

		for (const app_info of app_infos) {
			try {
				const themed_icon = app_info.get_icon(); // Returns a Gio.ThemedIcon
				if (!themed_icon) { continue; } // Don't copy icons if the app doesn't have one for some reason

				const icon_path_64 = theme.lookup_by_gicon(themed_icon, 64, 0).get_filename();

				// If the icon is an svg, we only need one copy of it	
				if (icon_path_64.endsWith('.svg')) {
					await this.cp(icon_path_64, this.icons_dir);
					continue;
				}

				// Otherwise, copy the 64 and 96 px raster images
				await this.cp(icon_path_64, this.icons_dir + '/64');
				const icon_path_96 = theme.lookup_by_gicon(themed_icon, 96, 0).get_filename();
				if (icon_path_96 !== null) await this.cp(icon_path_96, this.icons_dir + '/96');
			} catch (e) {
				// It's expected that some icon lookups won't succeed so we just catch everything and ignore it
				console.log('🦕 + ' + e)
			}
		}
	}

	/***
	 * An async copy function.
	 */
	async cp(source, dest) {
		const source_file = Gio.File.new_for_path(source);
		const dest_file = Gio.File.new_for_path(dest + '/' + source_file.get_basename());
		await source_file.copy_async(dest_file, Gio.FileCopyFlags.OVERWRITE, GLib.PRIORITY_DEFAULT, this.cancellable, null);
	}

	async log_app(app_id, app_name) {
		/***
		 * Adds a record to the database that the app was run today.
		 * 
		 * This is called each time the "app-state-changed" signal is fired.
		 */
		console.info('FickleFossTracker extension [log_app]: Logging an app');
		let date = Temporal.Now.plainDateISO();

		// Skip logging if an entry already exists for this app on this date
		// This is probably premature optimisation
		if (this.appsUsed[date]?.includes(app_id)) return;

		// Append app record to file
		const outputstream = this.queue_file.append_to(Gio.FileCreateFlags.NONE, null);
		try {
			outputstream.write_all(new TextEncoder().encode(`${date}\t${app_name}\t${app_id}\n`), null);
		} finally {
			outputstream.close(null);
		}

		if (!this.appsUsed[date]) this.appsUsed[date] = [];
		this.appsUsed[date].push(app_id);
		console.info('FickleFossTracker extension [log_app]: App logged');
	}

	async init_queue() {
		/***
		 * Creates an empty queue file
		 * 
		 * The queue is a list of apps and the date they were run. The queue file is processed by Fickle FOSS when it is run, which creates the necessary records in the database.
		 */
		// Get Gio file reference
		this.queue_file = Gio.File.new_for_path(this.queue_file_path);

		// Create queue file is doesn't exist - and silently catch GLib error if it does.
		try {
			this.queue_file.create(Gio.FileCreateFlags.NONE, null);
		} catch (e) {
			// See https://docs.gtk.org/glib/struct.Error.html
			// And https://gjs-docs.gnome.org/gio20/gio.ioerrorenum#default-exists
			if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS)) throw e;
		}
	}
}