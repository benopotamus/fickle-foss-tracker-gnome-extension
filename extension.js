import { Extension, gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import St from 'gi://St';

Gio._promisify(Gio.File.prototype, 'copy_async', 'copy_finish');


export default class FickleFossTracker extends Extension {

	cancellable = null;
	app_system = null;
	app_state_changed_connection = null;
	icons_dir = null;
	queue_dir_path = null;
	queue_file_path = null;
	queue_file = null;
	apps_used = null; // Prevent duplicate entries in the queue file

	async enable() {
		this.cancellable = new Gio.Cancellable()
		this.apps_used = {};

		// Figure out if Fickle FOSS is installed as a Flatpak by looking for "X-Flatpak" entry in the desktop file (if one exists)
		const fickle_app = Shell.AppSystem.get_default().lookup_app('giving.fickle.FickleFOSS.desktop');
		const fickle_app_info = fickle_app?.get_app_info();
		const is_flatpak = fickle_app_info?.has_key('X-Flatpak') ?? false;

		if (is_flatpak) {
			// icon cache is only needed for Flatpak version
			// NOTE the seemingly redundant "fickle-foss" in the paths is needed to match how the Fickle FOSS app uses XDG Dirs
			const flatpak_userfiles_dir = GLib.get_home_dir() + '/.var/app/giving.fickle.FickleFOSS';
			this.icons_dir = flatpak_userfiles_dir + '/cache/fickle-foss/app-icons-cache';
			this.queue_dir_path = flatpak_userfiles_dir + '/data/fickle-foss/';
		} else {
			this.queue_dir_path = GLib.get_user_data_dir() + "/fickle-foss/";
		}
		GLib.mkdir_with_parents(this.queue_dir_path, 0o700); // Create queue dir if needed
		this.queue_file_path = this.queue_dir_path + 'dbqueue';
		await this.init_queue();

		// icon cache is only needed for Flatpak version
		if (is_flatpak) {
			GLib.mkdir_with_parents(this.icons_dir, 0o700);
			this.update_icon_cache().catch(e => console.error(e));
		}

		this.app_system = Shell.AppSystem.get_default();
		this.app_state_changed_connection = this.app_system.connect("app-state-changed", (_, app) => {
			/* We need to match on RUNNING rather than STARTING because there's a few apps that don't go through the STARTING state. Possibly because they have `StartupNotify=false` in their `.desktop` files.
			 * The check for `get_app_info` is needed to filter out (windowless??) apps with names like "window:26" */
			if ((app.state == Shell.AppState.RUNNING) && (app.get_app_info() !== null)) {
				this.log_app(app.get_id(), app.get_name());
			}
		})
	}

	disable() {
		if (this.app_state_changed_connection) {
			this.app_system?.disconnect(this.app_state_changed_connection);
			this.app_state_changed_connection = null;
		}
		this.app_system = null;

		this.cancellable?.cancel();
		this.cancellable = null;

		this.icons_dir = null;
		this.queue_dir_path = null;
		this.queue_file_path = null;
		this.queue_file = null;
		this.apps_used = null;
	}

	/***
	 * Copies icon files to a directory where Flatpak Fickle FOSS can see it. Overwrites files if they exist.
	 */
	async update_icon_cache() {
		const theme = new St.IconTheme();
		const app_infos = Gio.AppInfo.get_all();

		for (const app_info of app_infos) {
			try {
				const themed_icon = app_info.get_icon(); // Returns a Gio.ThemedIcon
				if (!themed_icon) { continue; } // Don't copy icons if the app doesn't have one for some reason

				const icon_path_64 = theme.lookup_by_gicon(themed_icon, 64, 0).get_filename();
				const icon_path_96 = theme.lookup_by_gicon(themed_icon, 96, 0).get_filename();

				// Check for SVG icons first
				// Some apps have SVG's for 64px icons but SVG for 96px variant, so we work out if either of them are SVG first and just copy that one.
				if (icon_path_64?.endsWith('.svg')) {
					await this.copy_icon(app_info.get_id(), icon_path_64); // No size here. SVG is good for any size.
				} else if (icon_path_96?.endsWith('.svg')) {
					await this.copy_icon(app_info.get_id(), icon_path_96); // No size here. SVG is good for any size.

				// Otherwise, copy both raster image sizes
				} else {
					// Check if null as well, just in case an app only has one of the icon sizes
					if (icon_path_64 !== null) await this.copy_icon(app_info.get_id(), icon_path_64, 64);
					if (icon_path_96 !== null) await this.copy_icon(app_info.get_id(), icon_path_96, 96);
				}

			} catch (e) {
				// It's expected that some icon lookups won't succeed so we just catch everything and ignore it
			}
		}
	}

	/***
	 * The actual copy function.
	 */
	async copy_icon(desktop_file, icon_path, size=null) {
		const source_file = Gio.File.new_for_path(icon_path);
		let dest_file;

		if (source_file.get_basename().endsWith('.svg')) {
			dest_file = Gio.File.new_for_path(`${this.icons_dir}/${desktop_file}.svg`); // Add .svg to filename
		} else {
			dest_file = Gio.File.new_for_path(`${this.icons_dir}/${desktop_file}.${size}`); // Add .{size} to filename. This is used by Fickle FOSS to determine how to use the icon.
		}

		await source_file.copy_async(dest_file, Gio.FileCopyFlags.OVERWRITE, GLib.PRIORITY_DEFAULT, this.cancellable, null);
	}

	/***
	 * Adds a record to the queue file (denoting that an app was run on today's date) 
	 */
	async log_app(app_id, app_name) {

		let date = Temporal.Now.plainDateISO();

		// Skip logging if an entry already exists for this app on this date
		// This is probably premature optimisation
		if (this.apps_used[date]?.includes(app_id)) return;

		// Append app record to file
		const outputstream = this.queue_file.append_to(Gio.FileCreateFlags.NONE, null);
		try {
			outputstream.write_all(new TextEncoder().encode(`${date}\t${app_name}\t${app_id}\n`), null);
		} finally {
			outputstream.close(null);
		}

		if (!this.apps_used[date]) this.apps_used[date] = [];
		this.apps_used[date].push(app_id);
	}

	/***
	 * Creates an empty queue file
	 * 
	 * The queue is a list of apps and the date they were run. The queue file is processed by Fickle FOSS when it is run, which creates the necessary records in the database.
	 */
	async init_queue() {
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