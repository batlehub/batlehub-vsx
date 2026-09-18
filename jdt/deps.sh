#!/usr/bin/env bash
# `task jdt:deps`: the jars the bundle compiles against are the ones JDT.LS
# actually runs — taken from the pinned redhat.java VSIX (decision 8, 26),
# not from a p2 target platform. org.eclipse.jdt.ls.core is not on Maven
# Central at all; the others are, but at versions that need not match the
# server the bundle is loaded into. Installed under the groupId
# `batlehub.jdtls` with the jar's own version, `provided` scope in the pom.
set -euo pipefail
VERSION="${REDHAT_JAVA_VERSION:-1.56.0}"
CACHE="${HEAVY_CACHE:-$HOME/.cache/batlehub-heavy}"
VSIX="$CACHE/redhat.java-$VERSION.vsix"
DIR="$CACHE/redhat.java-$VERSION"
mkdir -p "$CACHE"
[[ -s "$VSIX" ]] || curl -fsSL --proto '=https' -o "$VSIX" "https://open-vsx.org/api/redhat/java/$VERSION/file/redhat.java-$VERSION.vsix"
[[ -d "$DIR/extension/server/plugins" ]] || { rm -rf "$DIR"; mkdir -p "$DIR"; unzip -q "$VSIX" -d "$DIR"; }
PLUGINS="$DIR/extension/server/plugins"
echo "$PLUGINS"
# artifactId = bundle symbolic name; version = what the file name carries.
for name in org.eclipse.jdt.ls.core org.eclipse.jdt.core org.eclipse.jdt.core.compiler.batch org.eclipse.jdt.core.manipulation org.eclipse.core.runtime org.eclipse.core.resources org.eclipse.core.jobs org.eclipse.core.contenttype org.eclipse.equinox.common org.eclipse.equinox.registry org.eclipse.equinox.preferences org.eclipse.text org.eclipse.lsp4j org.eclipse.lsp4j.jsonrpc com.google.gson org.eclipse.osgi; do
  jar="$(/bin/ls "$PLUGINS/${name}_"*.jar | head -1)"
  ver="$(basename "$jar" .jar)"; ver="${ver#${name}_}"
  if [[ -f "$HOME/.m2/repository/batlehub/jdtls/$name/$ver/$name-$ver.jar" ]]; then continue; fi
  mvn -q -B install:install-file -Dfile="$jar" -DgroupId=batlehub.jdtls -DartifactId="$name" -Dversion="$ver" -Dpackaging=jar
  echo "installed batlehub.jdtls:$name:$ver"
done
# The pom pins the versions: rewrite its <jdtls.*> properties from what was found.
POM="$(dirname "$0")/batlehub-jdt-core/pom.xml"
for name in org.eclipse.jdt.ls.core org.eclipse.jdt.core org.eclipse.jdt.core.compiler.batch org.eclipse.jdt.core.manipulation org.eclipse.core.runtime org.eclipse.core.resources org.eclipse.core.jobs org.eclipse.core.contenttype org.eclipse.equinox.common org.eclipse.equinox.registry org.eclipse.equinox.preferences org.eclipse.text org.eclipse.lsp4j org.eclipse.lsp4j.jsonrpc com.google.gson org.eclipse.osgi; do
  jar="$(/bin/ls "$PLUGINS/${name}_"*.jar | head -1)"; ver="$(basename "$jar" .jar)"; ver="${ver#${name}_}"
  sed -i "s|<v\.$name>[^<]*</v\.$name>|<v.$name>$ver</v.$name>|" "$POM"
done
echo "deps ready ($VERSION)"
