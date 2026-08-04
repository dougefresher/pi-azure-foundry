---
'@dougefresh/pi-azure-foundry': patch
---

Lowercase the package scope: `@dougEfresh/pi-azure-foundry` is now
`@dougefresh/pi-azure-foundry`. npm's naming rules forbid uppercase characters in
package names, so the old spelling was never publishable. Nothing at runtime
reads the package name — pi keys the provider off `azure-foundry` and Homebrew
installs to a path that never carried the scope.
