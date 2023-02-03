# InterSystems ServerDiff

This extension works with the [InterSystems ObjectScript](https://marketplace.visualstudio.com/items?itemName=intersystems-community.vscode-objectscript) extension to show as [gutter indicators](https://code.visualstudio.com/docs/sourcecontrol/overview#_gutter-indicators) any changes not yet present in the connected server namespace.

It uses a new proposed API function named `window.registerQuickDiffProvider` which was introduced in VS Code version 1.75.

## Setup

Extensions published on Marketplace cannot use proposed APIs. To overcome that restriction, when you first use this extension it will direct you this README. Complete the following steps:

1. From Command Palette choose `Preferences: Configure Runtime Arguments`.
2. In the `argv.json` file that opens, add this line within the outermost braces:
    ```json
    "enable-proposed-api": ["georgejames.intersystems-serverdiff"],
    ```
    If you already have an `"enable-proposed-api"` entry, add an extra value to its array value. For example:
    ```json
    "enable-proposed-api": [
        "intersystems-community.vscode-objectscript",
        "georgejames.intersystems-serverdiff"
    ]
    ```
3. Run `Developer: Reload Window`.

After the reload completes the extension will prompt you for permission to upgrade itself. When this completes you will be prompted to reload again.

## Use

1. Open some ObjectScript code, either a file in a local folder that you exported it into from an InterSystems server, or directly from a server namespace if you are using [server-side editing](https://intersystems-community.github.io/vscode-objectscript/serverside/).

2. Make changes, and watch indicators (changebars) appear in the gutter.

3. Click an indicator to peek at details.

4. The indicators remain until your changes get imported to the server. When using local files this happens by default when you save the file, unless you have set `"objectscript.importOnSave": false`. When doing server-side editing there is no equivalent option, so every save updates the server and clears the indicators.

If you are already using a source control extension that supports QuickDiff, such as Deltanji or VS Code's built-in Git one, indicators will also show differences from the source control perspective (e.g. changes not yet checked in, or not yet committed). The left end of the peek view's title tells you which QuickDiff provider(s) the information is coming from.



## Release Notes

See the [CHANGELOG](CHANGELOG.md) for changes in each release.

## About George James Software

Known for our expertise in InterSystems technologies, George James Software has been providing innovative software solutions for over 35 years. We focus on activities that can help our customers with the support and maintenance of their systems and applications. Our activities include consulting, training, support, and developer tools - with the Serenji debugger and Deltanji source control being our flagship tools. These tools augment InterSystems' technology and can help customers with the maintainability and supportability of their applications over the long term. 

To find out more, go to our website - [georgejames.com](https://georgejames.com) 

