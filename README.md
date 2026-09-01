# Fickle FOSS Tracker

For use with the Fickle FOSS app. Records the dates that apps are used. Fickle FOSS uses this app-date data to populate its list of apps to donate to.

Tracker also provides Fickle FOSS with app icons. This allows the Flatpak version of Fickle FOSS to display app icons for apps installed via package managers (zypper, apt-get, etc).

Based on https://extensions.gnome.org/extension/5592/focused-window-d-bus ❤️

# Installation

You can install this extension from Gnome Extensions

https://extensions.gnome.org/

# Command line usage

``gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/shell/extensions/FickleFossTracker --method org.gnome.shell.extensions.FickleFossTracker.Get``
