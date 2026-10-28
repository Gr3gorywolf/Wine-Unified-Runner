# proton-cli

Una CLI de TypeScript para gestionar capas de compatibilidad y lanzar ejecutables Windows con contenedores reproducibles. Está basada en los proveedores, selección de assets, prefijos y variables de entorno que utiliza Heroic Games Launcher 2.22.4, sin requerir Electron ni una interfaz gráfica.

En Linux maneja GE-Proton, Valve Proton, Proton-CachyOS y Wine-Lutris. En macOS usa las capas que Heroic soporta allí: Wine Staging, Wine-CrossOver y Game Porting Toolkit (GPTK). Proton es una capa Linux; por eso no se presenta como runtime ejecutable en macOS. `runtime list --all` permite inspeccionar todo el catálogo de Heroic desde cualquier plataforma.

## Instalar y compilar

```sh
npm install
npm run build
npm link
proton-cli --help
```

El binario publicado es `proton-cli`. Para ejecutarlo desde el árbol de trabajo antes de enlazarlo:

```sh
node dist/src/cli.js --help
```

## Flujo habitual

```sh
# Ver la recomendación exacta para el SO y la arquitectura actuales.
proton-cli suggest

# Ver las versiones que publica cada proveedor compatible con el sistema actual.
proton-cli runtime list
proton-cli proton list                 # Proton en Linux; Wine/GPTK en macOS
proton-cli runtime list --all          # también muestra las capas del otro SO

# Descargar un runtime concreto o la última versión.
proton-cli runtime install ge-proton latest
proton-cli runtime install proton GE-Proton10-1

# Ver e instalar los componentes compatibles y recomendados para este SO.
proton-cli component list --remote
proton-cli component list --remote --all # catálogo completo, incluido el otro SO
proton-cli component install dxvk

# Eliminar instalaciones autocontenidas. `delete` también es alias de `remove`.
proton-cli runtime remove game-porting-toolkit latest
proton-cli component remove dxvk-macos latest

# Instalar exactamente el runtime y los componentes habilitados en
# config/defaults.json para esta plataforma.
proton-cli install-recommended --dry-run
proton-cli install-recommended

# Construir todos los contenedores declarados en containers/*/config.json,
# o sólo uno concreto.
proton-cli build
proton-cli build --name cyberpunk

# Crear un prefijo/contenedor. --name es obligatorio.
proton-cli container create --name cyberpunk --runtime ge-proton/latest \
  --component dxvk-nvapi=true \
  --set launch.enableWayland=true

# Elegir el contenedor por defecto y ejecutar un .exe.
proton-cli container default --name cyberpunk
proton-cli run "/games/Cyberpunk 2077/bin/x64/Cyberpunk2077.exe" -- -skipStartScreen

# Elimina container.json y todo el prefijo. Si era el predeterminado,
# su selección se limpia y el próximo `run` creará uno nuevo.
proton-cli container remove --name cyberpunk

# O elegirlo sólo para una ejecución.
proton-cli run /games/setup.exe --container installers -- /silent
```

El primer `run` sin `--container` crea e inicializa automáticamente un contenedor llamado `default`, lo fija como predeterminado, descarga el runtime configurado y crea el prefijo. Proton se invoca con `waitforexitandrun`; Wine/GPTK se invoca directamente. La salida del juego se mantiene conectada a la terminal.

## Directorios y JSON

La CLI es autocontenida por defecto. La plantilla `defaults.json` queda junto a la CLI y su copia editable, ya adaptada al SO, se guarda como `config/defaults.json`. Runtimes, componentes, descargas, configuración, perfil de usuario y contenedores permanecen todos dentro de la carpeta compilada `dist/`. No escribe en `~/.local/share`, `~/Library/Application Support` ni directorios globales del sistema.

Todos los runtimes usan el mismo usuario de Windows, `user`. Cada prefijo expone `C:\\users\\user` mediante un enlace relativo a `dist/user/`, por lo que `AppData`, `Documents`, partidas guardadas y demás datos del perfil se comparten entre contenedores. Al preparar un prefijo antiguo, la CLI copia a ese perfil compartido los archivos que todavía no existan, conserva el perfil original como respaldo y no sigue los enlaces que Wine había creado hacia el home de macOS o Linux.

`proton-cli install-recommended` siempre toma su plan de ese `config/defaults.json`: instala el runtime definido en `container.runtime` y sólo los componentes cuyo campo `enabled` sea `true`. Así, cambiar el JSON (o usar `proton-cli defaults set`) cambia la siguiente instalación recomendada. `--dry-run` muestra el plan sin descargar nada. En macOS, el selector genérico `dxvk` se resuelve como `dxvk-macos`; en Linux se resuelve como DXVK normal.

Sólo si quieres separar explícitamente los datos de la instalación puedes definir `PROTON_CLI_HOME=/ruta/a/proton-cli` o usar `--home /ruta`.

También puedes usar `--home /ruta` en un único comando. La estructura resultante es:

```text
dist/
  defaults.json
  user/
    AppData/
    Documents/
    Saved Games/
  config/
    config.json
    defaults.json
  runtimes/
  components/
  containers/
    nombre/
      container.json
      prefix/
```

Cada contenedor es independiente: su archivo es `containers/<nombre>/container.json` y su prefijo Wine está en `containers/<nombre>/prefix`. El archivo contiene runtime, versión, componentes, arquitectura y opciones de lanzamiento. `proton-cli suggest` recomienda los valores válidos para el SO actual: Linux sugiere GE-Proton y DXVK/VKD3D; macOS en Apple Silicon sugiere GPTK, y en Intel Wine Staging. Un ejemplo reducido:

```json
{
  "name": "cyberpunk",
  "prefix": "/ruta/proton-cli/containers/cyberpunk/prefix",
  "runtime": { "source": "ge-proton", "version": "GE-Proton10-1" },
  "components": {
    "dxvk": { "enabled": true, "version": "latest" },
    "dxvkNvapi": { "enabled": true, "version": "latest" }
  },
  "launch": {
    "enableEsync": true,
    "enableWayland": true,
    "environment": { "DXVK_ASYNC": "1" }
  }
}
```

La sección `runtime` es siempre declarativa y sólo contiene `source` y `version`; no guarda rutas ni IDs de instalaciones locales. Al crear, construir o ejecutar un contenedor, la CLI busca primero ese runtime en `runtimes/`. Si no está, intenta instalarlo automáticamente y explica el fallo de descarga o de versión antes de iniciar el juego.

También puedes declarar un contenedor sin metadatos ni valores repetidos en `containers/<nombre>/config.json`, y construirlo después con `proton-cli build`. El manifiesto admite sólo `runtime`, `architecture`, `components` y `launch`; los campos que omitas se toman de `config/defaults.json`. El nombre y el prefijo siempre proceden de la carpeta, por lo que no puede escribir fuera de la instalación portátil.

```json
{
  "runtime": { "source": "game-porting-toolkit" },
  "components": {
    "dxvk": { "enabled": true }
  },
  "launch": {
    "enableMsync": true,
    "environment": { "WINEDEBUG": "-all" }
  }
}
```

`build` genera o actualiza `container.json`, descarga el runtime necesario, crea el prefijo y aplica los componentes habilitados. Si no pasas `--name`, procesa cada subcarpeta de `containers/` que incluya un `config.json`.

Puedes editarlo directamente o mantener cambios validados desde la CLI:

```sh
proton-cli defaults set --set runtime.source='"ge-proton"'
proton-cli container configure --name cyberpunk \
  --set launch.enableHdr=true \
  --set launch.environment.DXVK_ASYNC='"1"'
proton-cli container show --name cyberpunk --json
```

Las opciones de `launch` mapean las mismas configuraciones de Heroic: esync/fsync/msync, Wayland, HDR, WoW64, FSR, límite DXVK, HUD/FPS, NVAPI y variables de entorno. DXVK/VKD3D se instalan en prefijos Wine. Un runtime Proton ya los trae integrados, así que la CLI no los sobreescribe. EAC y BattlEye se descargan desde el listado de runtimes de Lutris si están habilitados en un contenedor Linux. DXMT está disponible como componente descargable para construir o inspeccionar una variante Wine Staging de macOS; GPTK se mantiene intacto, igual que en Heroic.

## Integridad y comportamiento de descarga

Las versiones se consultan directamente desde las APIs de GitHub que usa Heroic. Las descargas GE-Proton y Proton-CachyOS verifican SHA-512 cuando el release publica el archivo de checksum. La extracción ocurre primero en un directorio temporal y el runtime o componente sólo se mueve a su ubicación final cuando termina correctamente.

`runtime installed` y `component list` muestran las instalaciones locales. Todos los comandos que aceptan listados tienen salida de máquina con `--json`.

## Licencia y atribución

Este proyecto conserva licencia GPL-3.0-only por su implementación basada en el comportamiento y los proveedores de [Heroic Games Launcher](https://github.com/Heroic-Games-Launcher/HeroicGamesLauncher), versión de referencia 2.22.4. Los runtimes, componentes y sus licencias siguen perteneciendo a sus respectivos proyectos y proveedores.
