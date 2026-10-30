# 🧱 VR Gym — WebXR Mixed Reality para Meta Quest

Una SPA para aprender **WebXR** construyendo una app de **realidad mixta** que
interactúa con tu entorno real: usa el passthrough de las cámaras, detecta
superficies (suelo, paredes, mesas) y deja lanzar **cubos y esferas con física**
—rebotes, apilamiento y torres que se derrumban— controlado todo con las **manos**.

## Qué hace

- **Passthrough / realidad mixta**: sesión `immersive-ar`, ves tu habitación real.
- **Detección del entorno**: `plane-detection` convierte las superficies reales
  (suelo, paredes, mesas) de tu *Space Setup* en colisionadores físicos, así que
  **puedes apoyar y apilar objetos sobre tu mesa real** y rebotarlos contra las
  paredes. Las superficies se pintan tenuemente (verde = apoyables, azul = paredes)
  y el HUD indica cuántas detectó. `mesh-detection` queda solicitado para ampliarlo
  a la malla completa de la sala (ver ideas abajo).
- **Física real** (cannon-es): gravedad, las esferas rebotan, los cubos se apilan
  y las torres se caen si las golpeas.
- **Control por manos** (sin mandos): pellizca para crear, **agarra y lanza**
  objetos, y **golpéalos con la mano** para proyectarlos (hand-tracking).

## Gestos

| Gesto | Acción |
|-------|--------|
| 👌 Pellizco pulgar + índice **en el aire** (mano **derecha**) | Crea una **esfera** (rebota) |
| 👌 Pellizco pulgar + índice **en el aire** (mano **izquierda**) | Crea un **cubo** (se apila) |
| ✊ Pellizco pulgar + índice **sobre un objeto** | Lo **agarra** y lo mueves con la mano |
| 🚀 Abre la mano mientras la mueves | **Lanza** el objeto agarrado con esa velocidad |
| 👊 Golpea un objeto con la mano | Sale **proyectado** (las yemas y la palma son colisionadores) |
| 🤏 Pellizco pulgar + **corazón** (cualquier mano) | Borra todos los objetos |

## Cómo probarlo

1. **GitHub Pages**: en el repo → *Settings → Pages* → *Deploy from branch* →
   `main` / `root`. WebXR exige HTTPS y Pages ya lo da.
2. En las **Meta Quest**, abre el navegador y entra a la URL
   (`https://vrgym.github.io`).
3. Activa el **tracking de manos** en la Quest (*Ajustes → Movimiento → Hand tracking*).
4. Pulsa **Entrar en Realidad Mixta** y acepta los permisos.
5. Mueve la cabeza por la sala unos segundos para que detecte las superficies
   (verás tenues rectángulos azules sobre paredes y mesas), y empieza a pellizcar.

> La detección de planos necesita que hayas configurado el **Space Setup / guardián
> de la sala** en la Quest para tener datos de paredes y muebles.

## Solución de problemas

**Los objetos atraviesan la mesa y el suelo / caen al vacío.** Significa que no se
está detectando ningún plano. El HUD (abajo) te dice qué pasa:

- `API de planos NO disponible` → el navegador no habilitó `plane-detection`.
  Actualiza el navegador de la Quest; esta app lo pide como *required* para forzar
  el permiso.
- `Planos: 0 — permite DATOS ESPACIALES` → al entrar aparece un prompt pidiendo
  acceso a los **datos espaciales / de la sala**: hay que **aceptarlo**. Si lo
  rechazaste, sal y vuelve a entrar. Comprueba también que el **Space Setup** de
  *esta* habitación esté hecho (*Ajustes → Espacio físico → Configurar*).
- `Planos: N` con `pd✓ ht✓` → todo bien; los objetos deberían apoyarse en las
  superficies verdes (suelo/mesas) y azules (paredes).

El bloque entre `[ ]` del HUD muestra las *features* activas: `pd`=plane-detection,
`md`=mesh-detection, `ht`=hand-tracking (✓/✗), y el número de mallas detectadas.

## Desarrollo local

No hace falta build: son ES modules desde CDN. Pero WebXR requiere un origen
seguro, así que para probar en el visor sirve por HTTPS (o usa `adb reverse` +
`localhost`, que cuenta como seguro):

```bash
# servidor estático simple
npx serve .
# luego en la Quest conectada por USB:
adb reverse tcp:3000 tcp:3000   # abre http://localhost:3000 en el visor
```

## Estructura

```
index.html      # landing + importmap + HUD
src/main.js      # escena Three.js, mundo físico, planos XR y gestos de mano
```

## Stack

- [Three.js](https://threejs.org/) `0.169` — render y helpers WebXR (ARButton, XRHandModelFactory)
- [cannon-es](https://pmndrs.github.io/cannon-es/) `0.20` — física de cuerpos rígidos
- WebXR Device API: `immersive-ar`, `plane-detection`, `mesh-detection`, `hand-tracking`

## Ideas para seguir aprendiendo

- Anclar los objetos al mundo con `anchors` para que persistan al moverte.
- Usar la malla (`mesh-detection`) como colisionador *trimesh* en vez de cajas.
- Distinguir superficies por su `semanticLabel` (mesa, pared, suelo, techo).
- Sonidos de impacto espacializados con la Web Audio API.
