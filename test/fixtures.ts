export const mainHtml = `
<table class="tablaresultados"><thead><tr><th>Nombre</th><th>Número</th><th>Quinta</th><th>Serie</th><th>Fecha</th><th></th></tr></thead><tbody>
<tr><td>Antioqueñita Día</td><td><span class="balotera-home">0</span><span class="balotera-home">0</span><span class="balotera-home">1</span><span class="balotera-home">7</span></td><td>9</td><td>AB12</td><td>2026-07-23</td><td><a class="botonres_vmas" href="/resultados/resultados-sorteo-antioquenita-dia/">VER MÁS</a></td></tr>
</tbody></table>
<table class="tablaresultados"><thead><tr><th>Nombre</th><th>Número</th><th>Fecha</th><th></th></tr></thead><tbody>
<tr><td>Chontico Día</td><td><div class="cajon-baloteras"><span class="balotera-home">4</span><span class="balotera-home">2</span><span class="balotera-home">0</span><span class="balotera-home">3</span></div></td><td>23/07/2026</td><td><a class="botonres_vmas" href="https://jer.com.co/resultados/chontico-dia/">VER MÁS</a></td></tr>
</tbody></table>
<table class="tablaresultados"><thead><tr><th>Nombre</th><th>Número</th><th>Signo</th><th>Fecha</th></tr></thead><tbody><tr><td>Super Astro Sol</td><td><span class="balotera-home">8</span><span class="balotera-home">8</span><span class="balotera-home">1</span><span class="balotera-home">0</span></td><td>Aries</td><td>2026-07-23</td><td><a href="/resultados/astro-sol/">VER MÁS</a></td></tr></tbody></table>
<table class="tablaresultados"><thead><tr><th>Nombre</th><th>Número</th><th>Fecha</th></tr></thead><tbody><tr><td>Dupla</td><td>0012</td><td>2026-07-23</td><td><a class="botonres_vmas" href="/resultados/dupla/">VER MÁS</a></td></tr></tbody></table>`;

export const historyWithFifth = `<form><select name="fecha"><option value="2026-07-23">23</option><option value="bad">Bad</option><option value="">Choose</option></select></form><div class="cajonconquinta"><h4>Resultado 2026-07-23</h4><div class="balotera-home-interno">3</div><div class="balotera-home-interno">9</div><div class="balotera-home-interno">9</div><div class="balotera-home-interno">2</div><div class="balotera-home-interno colorquinta">9</div></div>`;
export const historyWithoutFifth = `<div class="cajonsinquinta"><h4>Resultado 2026-07-23</h4><div class="balotera-home-interno">0</div><div class="balotera-home-interno">0</div><div class="balotera-home-interno">1</div><div class="balotera-home-interno">7</div></div>`;
export const invalidHistory = `<div class="cajonconquinta"><h4>Resultado 2026-07-23</h4><div class="balotera-home-interno">X</div></div>`;

export const historicalAstroSibling = `
  <section class="resultado-historico">
    <h4>Resultado 2026-07-23</h4>
    <div class="baloteras"><span class="balotera-home">0</span><span class="balotera-home">0</span><span class="balotera-home">7</span><span class="balotera-home">4</span></div>
    <p class="signozodiacal">Signo: Piscis</p>
  </section>`;

export const historicalLotterySibling = `
  <section class="resultado-historico">
    <h4>Resultado 2026-07-23</h4>
    <div class="cajonconquinta"><span class="balotera-home-interno">0</span><span class="balotera-home-interno">0</span><span class="balotera-home-interno">1</span><span class="balotera-home-interno">7</span><span class="balotera-home-interno colorquinta">9</span></div>
    <p class="serie">Serie: AB12</p>
  </section>`;

export const ambiguousHistoricalSibling = `
  <section class="resultado-historico">
    <h4>Resultado 2026-07-23</h4>
    <div class="baloteras"><span class="balotera-home">0</span><span class="balotera-home">0</span><span class="balotera-home">7</span><span class="balotera-home">4</span></div>
    <div class="baloteras"><span class="balotera-home">1</span><span class="balotera-home">2</span><span class="balotera-home">3</span><span class="balotera-home">4</span></div>
    <p class="signozodiacal">Signo: Piscis</p>
  </section>`;

export const missingHistoricalSibling = `<section class="resultado-historico"><h4>Resultado 2026-07-23</h4><p class="signozodiacal">Signo: Piscis</p></section>`;

// Sanitized structural characterization of the live Astro Sol historical layout.
export const historicalAstroCurrentLayout = `
  <div class="column_attr clearfix">
    <div><h4>Resultado 2026-07-23</h4></div>
    <div><div class="cajon-baloteras"><div class="balotera-home-interno">3</div><div class="balotera-home-interno">9</div><div class="balotera-home-interno">6</div><div class="balotera-home-interno">1</div></div></div>
    <div>SIGNO: sagitario</div>
  </div>`;

export const historicalAstroCurrentLayoutWithConflictingSigns = `
  <div class="column_attr clearfix">
    <div><h4>Resultado 2026-07-23</h4></div>
    <div><div class="cajon-baloteras"><div class="balotera-home-interno">3</div><div class="balotera-home-interno">9</div><div class="balotera-home-interno">6</div><div class="balotera-home-interno">1</div></div></div>
    <div><p>SIGNO: sagitario</p><p>SIGNO: aries</p></div>
  </div>`;
