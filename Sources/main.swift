import Foundation

private func disableNativeWindowRestorationBeforeLaunch() {
    UserDefaults.standard.register(defaults: [
        "ApplePersistenceIgnoreState": true,
        "NSQuitAlwaysKeepsWindows": false,
    ])
}

private func clearStaleSavedApplicationStateBeforeLaunch() {
    guard let bundleIdentifier = Bundle.main.bundleIdentifier else { return }

    let fileManager = FileManager.default
    guard let libraryURL = fileManager.urls(for: .libraryDirectory, in: .userDomainMask).first else { return }

    let savedStateURL = libraryURL
        .appendingPathComponent("Saved Application State", isDirectory: true)
        .appendingPathComponent("\(bundleIdentifier).savedState", isDirectory: true)

    if fileManager.fileExists(atPath: savedStateURL.path) {
        try? fileManager.removeItem(at: savedStateURL)
    }
}

disableNativeWindowRestorationBeforeLaunch()
clearStaleSavedApplicationStateBeforeLaunch()
cmuxApp.main()
