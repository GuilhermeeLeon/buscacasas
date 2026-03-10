import * as cheerio from "cheerio";
import * as fs from "fs";
import * as path from "path";
import puppeteerExtra from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";

puppeteerExtra.use(StealthPlugin());

// ─── Filtros — Aluguel ───────────────────────────────────────────────────────
const PRECO_MIN = 2000;
const PRECO_MAX = 3500;
const QUARTOS_MIN = 2;

// ─── Filtros — Venda ─────────────────────────────────────────────────────────
const VENDA_PRECO_MIN = 250000;
const VENDA_PRECO_MAX = 400000;
const VENDA_TERRENO_MIN = 250;

// ─── Tipos ──────────────────────────────────────────────────────────────────
interface Imovel {
  id: string;
  titulo: string;
  preco: number;
  quartos: number;
  area: number; // terreno em m² (0 = não informado)
  endereco: string;
  url: string;
  site: string;
}

interface Estado {
  vistos: string[];
  ultimaRodada: string;
}

// ─── Headers para evitar bloqueio ────────────────────────────────────────────
const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
  "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8",
};

// ─── Helpers ─────────────────────────────────────────────────────────────────
function extrairPreco(texto: string): number {
  if (!texto) return 0;
  const limpo = texto
    .replace(/R\$\s*/gi, "")
    .replace(/\./g, "")
    .replace(",", ".")
    .replace(/[^\d.]/g, "")
    .trim();
  const val = parseFloat(limpo);
  return isNaN(val) ? 0 : val;
}

function extrairArea(texto: string): number {
  const m = texto.match(/(\d[\d.,]*)\s*m[²2]/i);
  if (!m) return 0;
  const val = parseFloat(m[1].replace(/\./g, "").replace(",", "."));
  return isNaN(val) ? 0 : val;
}

function extrairQuartosDaDescricao(texto: string): number {
  const padroes = [
    /(\d+)\s*su[ií]te/i,
    /(\d+)\s*dorm/i,
    /(\d+)\s*quarto/i,
    /(\d+)\s*bedroom/i,
  ];
  for (const p of padroes) {
    const m = texto.match(p);
    if (m) return parseInt(m[1]);
  }
  return 0;
}

function normalizarUrl(href: string, baseUrl: string): string {
  if (!href) return "";
  if (href.startsWith("http")) return href;
  if (href.startsWith("//")) return "https:" + href;
  const base = new URL(baseUrl);
  return `${base.protocol}//${base.host}${href.startsWith("/") ? "" : "/"}${href}`;
}

async function fetchPagina(url: string): Promise<string | null> {
  try {
    const resp = await fetch(url, {
      headers: HEADERS,
      signal: AbortSignal.timeout(15000),
    });
    if (!resp.ok) return null;
    return await resp.text();
  } catch {
    return null;
  }
}

// ─── Scraper: plataforma ImobiBrasil ─────────────────────────────────────────
function scrapeImobiBrasil(html: string, baseUrl: string, siteNome: string): Imovel[] {
  const $ = cheerio.load(html);
  const imoveis: Imovel[] = [];

  $(".imovelcard[data-link]").each((_, el) => {
    const card = $(el);
    const link = card.attr("data-link") || card.find("a[href]").first().attr("href") || "";
    const url = normalizarUrl(link, baseUrl);
    if (!url) return;

    const precoTexto = card.find(".imovelcard__valor__valor").text();
    const preco = extrairPreco(precoTexto);

    const local = card.find(".imovelcard__info__local").text().trim();
    if (local && !local.toLowerCase().includes("itu")) return;

    const descricao = card.find("[class*='descricao'] h3").text();
    let quartos = extrairQuartosDaDescricao(descricao);
    if (quartos === 0) quartos = extrairQuartosDaDescricao(card.text());
    if (quartos === 0) quartos = QUARTOS_MIN;

    const ref = card.find(".imovelcard__info__ref").text().trim();
    const titulo = ref || `Casa em ${local || "Itu"}`;
    const area = extrairArea(card.find(".imovelcard__caracteristicas").text() + " " + card.text());

    imoveis.push({ id: url, titulo, preco, quartos, area, endereco: local || "Itu, SP", url, site: siteNome });
  });

  return imoveis;
}

// ─── Scraper: genérico ────────────────────────────────────────────────────────
function scrapeGenerico(html: string, baseUrl: string, siteNome: string): Imovel[] {
  const $ = cheerio.load(html);
  const imoveis: Imovel[] = [];

  const cardSelectors = [
    ".imovelcard[data-link]",
    "[class*='imovel-card']",
    "[class*='property-card']",
    "[class*='listing-card']",
    "article.card",
    ".card-imovel",
  ];

  const precoSelectors = [
    "[class*='preco']",
    "[class*='valor']",
    "[class*='price']",
    "strong",
  ];

  for (const cardSel of cardSelectors) {
    const cards = $(cardSel);
    if (cards.length < 1) continue;

    cards.each((_, el) => {
      const card = $(el);
      const link =
        card.attr("data-link") ||
        (card.is("a") ? card.attr("href") : card.find("a[href]").first().attr("href")) ||
        "";
      const url = normalizarUrl(link, baseUrl);
      if (!url) return;

      let preco = 0;
      for (const pSel of precoSelectors) {
        const p = extrairPreco(card.find(pSel).first().text());
        if (p > 0) { preco = p; break; }
      }
      if (preco === 0) {
        const m = card.text().match(/R\$\s*([\d.]+,\d{2})/);
        if (m) preco = extrairPreco(m[0]);
      }

      const texto = card.text();
      let quartos = extrairQuartosDaDescricao(texto);
      const area = extrairArea(texto);
      const local = card.find("[class*='local'], [class*='endereco'], [class*='address']").first().text().trim();

      if (local && !local.toLowerCase().includes("itu")) return;

      if (preco > 0) {
        imoveis.push({
          id: url,
          titulo: card.find("h2, h3, [class*='titulo']").first().text().trim() || "Casa",
          preco,
          quartos: quartos || QUARTOS_MIN,
          area,
          endereco: local || "Itu, SP",
          url,
          site: siteNome,
        });
      }
    });

    if (imoveis.length > 0) break;
  }

  return imoveis;
}

// ─── Scraper: MN Imoveis (plataforma imoview customizada) ────────────────────
function scrapeMnImoveis(html: string, baseUrl: string): Imovel[] {
  const $ = cheerio.load(html);
  const imoveis: Imovel[] = [];

  $(".wrap_card_imovel").each((_, el) => {
    const card = $(el);
    const link = card.find("a[href]").first().attr("href") || "";
    const url = normalizarUrl(link, baseUrl);
    if (!url) return;

    const preco = extrairPreco(card.find("strong.preco-imovel-card").text());
    const endereco = card.find("span.card-text").first().text().trim();
    if (endereco && !endereco.toLowerCase().includes("itu")) return;

    const quartos = extrairQuartosDaDescricao(card.text()) || QUARTOS_MIN;
    const area = extrairArea(card.text());
    const titulo = card.find("h2.card-title").text().trim() || "Casa";

    imoveis.push({ id: url, titulo, preco, quartos, area, endereco: endereco || "Itu, SP", url, site: "MN Imoveis Itu" });
  });

  return imoveis;
}

// ─── Scraper: Silvana Carvalho (plataforma imoview/publicar) ─────────────────
function scrapeSilvanaCarvalho(html: string): Imovel[] {
  const $ = cheerio.load(html);
  const imoveis: Imovel[] = [];

  $(".col-xs-12.grid-imovel").each((_, el) => {
    const card = $(el);
    const link = card.find("a.swiper-wrapper[href]").first().attr("href") ||
                 card.find("a[href]").first().attr("href") || "";
    if (!link) return;

    const preco = extrairPreco(card.find("span.thumb-price").first().text());
    const endereco = card.find("h3[itemprop='streetAddress']").text().trim();
    if (endereco && !endereco.toLowerCase().includes("itu")) return;

    const quartos = extrairQuartosDaDescricao(card.find(".property-amenities").text()) || QUARTOS_MIN;
    const area = extrairArea(card.text());
    const titulo = card.find("h2.titulo-grid").text().trim() || "Imóvel";

    imoveis.push({ id: link, titulo, preco, quartos, area, endereco: endereco || "Itu, SP", url: link, site: "Silvana Carvalho Imoveis" });
  });

  return imoveis;
}

// ─── Scraper: sites que carregam via JavaScript (Puppeteer) ──────────────────
async function fetchPaginaComJs(url: string): Promise<string | null> {
  let browser;
  try {
    const puppeteer = await import("puppeteer");
    browser = await puppeteer.default.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
    });
    const page = await browser.newPage();
    await page.setUserAgent(HEADERS["User-Agent"]);
    await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });
    await new Promise((resolve) => setTimeout(resolve, 3000));
    return await page.content();
  } catch (e) {
    console.warn(`  [!] Puppeteer falhou para ${url}: ${e}`);
    return null;
  } finally {
    if (browser) await browser.close();
  }
}

// ─── Scraper: portais grandes com anti-bot (Puppeteer + Stealth) ──────────────
async function fetchComStealth(url: string, waitForSelector?: string): Promise<string | null> {
  let browser;
  try {
    browser = await puppeteerExtra.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
    });
    const page = await browser.newPage();
    await page.setUserAgent(HEADERS["User-Agent"]);
    await page.setExtraHTTPHeaders({ "Accept-Language": "pt-BR,pt;q=0.9" });
    await page.goto(url, { waitUntil: "networkidle2", timeout: 45000 });
    if (waitForSelector) {
      await page.waitForSelector(waitForSelector, { timeout: 10000 }).catch(() => {});
    }
    await new Promise((resolve) => setTimeout(resolve, 4000));
    return await page.content();
  } catch (e) {
    console.warn(`  [!] fetchComStealth falhou para ${url}: ${e}`);
    return null;
  } finally {
    if (browser) await browser.close();
  }
}

// ─── Scraper: Kenlo (API direta — /api/listings com paginação) ───────────────
interface KenloApiItem {
  property_full_reference: string;
  property_purposes: string | string[];
  property_type: string;
  city: string;
  neighborhood: string;
  rent_price: [number, number];
  sale_price: [number, number];
  land_area: number;
  bedrooms: [number, number];
  url: string;
  website_title?: string;
}

interface KenloApiResponse {
  data: KenloApiItem[];
  count: number;
}

async function fetchKenloApi(baseUrl: string, siteNome: string, finalidade: "aluguel" | "venda" = "aluguel"): Promise<Imovel[]> {
  const origem = new URL(baseUrl);
  const apiBase = `${origem.protocol}//${origem.host}`;
  const imoveis: Imovel[] = [];
  let page = 1;
  const pageSize = 100;
  const purposeFilter = finalidade === "venda" ? "FOR_SALE" : "FOR_RENT";

  try {
    while (true) {
      const resp = await fetch(`${apiBase}/api/listings?size=${pageSize}&page=${page}`, {
        headers: {
          ...HEADERS,
          "Accept": "application/json",
          "Referer": baseUrl,
        },
        signal: AbortSignal.timeout(15000),
      });
      if (!resp.ok) break;

      const json = await resp.json() as KenloApiResponse;
      if (!json.data || json.data.length === 0) break;

      for (const item of json.data) {
        const purposes = Array.isArray(item.property_purposes) ? item.property_purposes : [item.property_purposes];
        if (!purposes.includes(purposeFilter)) continue;

        // Só casas
        if (item.property_type !== "HOUSE" && item.property_type !== "OUTHOUSE") continue;

        // Só Itu
        if (!item.city?.toLowerCase().includes("itu")) continue;

        const preco = finalidade === "venda" ? (item.sale_price?.[0] ?? 0) : (item.rent_price?.[0] ?? 0);
        if (preco === 0) continue;

        const quartos = item.bedrooms?.[0] ?? QUARTOS_MIN;
        const area = item.land_area ?? 0;
        const bairro = item.neighborhood || "";
        const endereco = bairro ? `${bairro} | ${item.city}` : item.city;
        const itemUrl = item.url?.startsWith("http") ? item.url : `${apiBase}${item.url}`;
        const titulo = item.website_title || "Casa";

        imoveis.push({
          id: itemUrl,
          titulo,
          preco,
          quartos,
          area,
          endereco,
          url: itemUrl,
          site: siteNome,
        });
      }

      // Se retornou menos que o tamanho da página, chegamos ao fim
      if (json.data.length < pageSize) break;
      page++;
    }

    console.log(`  ${siteNome}: ${imoveis.length} casa(s) para ${finalidade} em Itu encontrada(s) via API`);
    return imoveis;
  } catch (e) {
    console.warn(`  [!] Kenlo API falhou para ${baseUrl}: ${e}`);
    return [];
  }
}

// ─── Scraper: ImovelWeb ───────────────────────────────────────────────────────
function scrapeImovelWeb(html: string): Imovel[] {
  const $ = cheerio.load(html);
  const imoveis: Imovel[] = [];

  $("[data-qa='posting PROPERTY']").each((_, el) => {
    const card = $(el);

    const dataTo = card.attr("data-to-posting") || "";
    if (!dataTo) return;
    const url = `https://www.imovelweb.com.br${dataTo.replace(/&amp;/g, "&")}`;

    const precoTexto = card.find("[data-qa='POSTING_CARD_PRICE']").first().text();
    const preco = extrairPreco(precoTexto);
    if (preco === 0) return;

    // Endereço: bairro/cidade
    const endereco = card.find("[data-qa='POSTING_CARD_LOCATION']").first().text().trim() || "Itu, SP";

    // Título: primeira parte da descrição (antes do " - ") ou até 80 chars
    const descricaoEl = card.find("[data-qa='POSTING_CARD_DESCRIPTION']");
    const descricaoTexto = descricaoEl.find("a").first().text().trim();
    const tituloRaw = descricaoTexto.split(" - ")[0] || descricaoTexto.split("\n")[0] || "Casa";
    const titulo = tituloRaw.slice(0, 80);

    const quartos = extrairQuartosDaDescricao(card.text()) || QUARTOS_MIN;
    const area = extrairArea(card.text());

    imoveis.push({
      id: url,
      titulo,
      preco,
      quartos,
      area,
      endereco,
      url,
      site: "ImovelWeb",
    });
  });

  return imoveis;
}

// ─── Configuração dos sites ───────────────────────────────────────────────────
interface SiteConfig {
  nome: string;
  plataforma: "imobibrasil" | "generica" | "mn-imoveis" | "silvana" | "kenlo" | "imovelweb";
  urlsBusca: string[];
  finalidade?: "aluguel" | "venda";
}

const SITES: SiteConfig[] = [
  {
    nome: "Bochini Imoveis",
    plataforma: "imobibrasil",
    urlsBusca: [
      "https://www.bochiniimoveis.com.br/imovel/?finalidade=locacao&tipo=casa&dormitorios=22&vmi=2000&vma=3500",
      "https://www.bochiniimoveis.com.br/imovel/?finalidade=locacao&tipo=casa-em-condominio&dormitorios=22&vmi=2000&vma=3500",
      "https://www.bochiniimoveis.com.br/imovel/?finalidade=locacao&tipo=casa&dormitorios=22",
    ],
  },
  {
    nome: "Baroni Imoveis",
    plataforma: "imobibrasil",
    urlsBusca: [
      "https://www.baroniimoveis.com.br/imovel/?finalidade=locacao&tipo=casa&dormitorios=22&vmi=2000&vma=3500",
      "https://www.baroniimoveis.com.br/imovel/?finalidade=locacao&tipo=casa-em-condominio&dormitorios=22&vmi=2000&vma=3500",
      "https://www.baroniimoveis.com.br/imovel/?finalidade=locacao&tipo=casa&dormitorios=22",
    ],
  },
  {
    nome: "MN Imoveis Itu",
    plataforma: "mn-imoveis",
    urlsBusca: [
      "https://www.mnimoveisitu.com.br/aluguel/casa/",
      "https://www.mnimoveisitu.com.br/aluguel/casa-condominio/",
    ],
  },
  {
    nome: "Silvana Carvalho Imoveis",
    plataforma: "silvana",
    urlsBusca: [
      "https://silvanacarvalho.com.br/busca/?finalidade=aluguel&categoriagrupo=Residencial",
    ],
  },
  {
    nome: "Utuguacu Imoveis",
    plataforma: "kenlo",
    urlsBusca: [
      "https://www.utuguacu.com.br/imoveis/aluguel",
    ],
  },
  {
    nome: "Proimovel Negocios Imobiliarios",
    plataforma: "kenlo",
    urlsBusca: [
      "https://www.proimovel-itu.com.br/imoveis/aluguel",
    ],
  },
  {
    nome: "GS Imoveis Itu",
    plataforma: "kenlo",
    urlsBusca: [
      "https://www.gsimoveisitu.com.br/imoveis?finalidade=Locacao&tipo=Casa",
    ],
  },
  {
    nome: "Opcao Imoveis Itu",
    plataforma: "kenlo",
    urlsBusca: [
      "https://www.opcaoimoveisitu.com.br/imoveis/aluguel",
    ],
  },
  {
    nome: "Seu Imovel Itu",
    plataforma: "kenlo",
    urlsBusca: [
      "https://www.seuimovelitu.com.br/imoveis/aluguel",
    ],
  },
  {
    nome: "Beto Imoveis",
    plataforma: "kenlo",
    urlsBusca: [
      "https://www.betoimoveis.com.br/imoveis/para-alugar/casa",
      "https://www.betoimoveis.com.br/imoveis/para-alugar/sobrado",
    ],
  },
  {
    nome: "ImovelWeb",
    plataforma: "imovelweb",
    urlsBusca: [
      "https://www.imovelweb.com.br/casas-aluguel-itu-sp-precio-desde-2000-hasta-3500.html?ambientesminimo=2",
    ],
  },
];

// ─── Sites de Venda ───────────────────────────────────────────────────────────
const SITES_VENDA: SiteConfig[] = [
  {
    nome: "Bochini Imoveis",
    plataforma: "imobibrasil",
    finalidade: "venda",
    urlsBusca: [
      "https://www.bochiniimoveis.com.br/imovel/?finalidade=venda&tipo=casa&vmi=250000&vma=400000",
      "https://www.bochiniimoveis.com.br/imovel/?finalidade=venda&tipo=casa-em-condominio&vmi=250000&vma=400000",
    ],
  },
  {
    nome: "Baroni Imoveis",
    plataforma: "imobibrasil",
    finalidade: "venda",
    urlsBusca: [
      "https://www.baroniimoveis.com.br/imovel/?finalidade=venda&tipo=casa&vmi=250000&vma=400000",
      "https://www.baroniimoveis.com.br/imovel/?finalidade=venda&tipo=casa-em-condominio&vmi=250000&vma=400000",
    ],
  },
  {
    nome: "MN Imoveis Itu",
    plataforma: "mn-imoveis",
    finalidade: "venda",
    urlsBusca: [
      "https://www.mnimoveisitu.com.br/venda/casa/",
      "https://www.mnimoveisitu.com.br/venda/casa-condominio/",
    ],
  },
  {
    nome: "Silvana Carvalho Imoveis",
    plataforma: "silvana",
    finalidade: "venda",
    urlsBusca: [
      "https://silvanacarvalho.com.br/busca/?finalidade=venda&categoriagrupo=Residencial",
    ],
  },
  {
    nome: "Utuguacu Imoveis",
    plataforma: "kenlo",
    finalidade: "venda",
    urlsBusca: [
      "https://www.utuguacu.com.br/imoveis/venda",
    ],
  },
  {
    nome: "Proimovel Negocios Imobiliarios",
    plataforma: "kenlo",
    finalidade: "venda",
    urlsBusca: [
      "https://www.proimovel-itu.com.br/imoveis/venda",
    ],
  },
  {
    nome: "GS Imoveis Itu",
    plataforma: "kenlo",
    finalidade: "venda",
    urlsBusca: [
      "https://www.gsimoveisitu.com.br/imoveis?finalidade=Venda&tipo=Casa",
    ],
  },
  {
    nome: "Opcao Imoveis Itu",
    plataforma: "kenlo",
    finalidade: "venda",
    urlsBusca: [
      "https://www.opcaoimoveisitu.com.br/imoveis/venda",
    ],
  },
  {
    nome: "Seu Imovel Itu",
    plataforma: "kenlo",
    finalidade: "venda",
    urlsBusca: [
      "https://www.seuimovelitu.com.br/imoveis/venda",
    ],
  },
  {
    nome: "Beto Imoveis",
    plataforma: "kenlo",
    finalidade: "venda",
    urlsBusca: [
      "https://www.betoimoveis.com.br/imoveis/para-vender/casa",
    ],
  },
  {
    nome: "ImovelWeb",
    plataforma: "imovelweb",
    finalidade: "venda",
    urlsBusca: [
      "https://www.imovelweb.com.br/casas-venda-itu-sp-precio-desde-250000-hasta-400000.html",
    ],
  },
];

// ─── Scrape de um site ────────────────────────────────────────────────────────
async function raspaSite(site: SiteConfig): Promise<Imovel[]> {
  for (const url of site.urlsBusca) {
    console.log(`  ${site.nome} → ${url}`);

    // Sites Kenlo: API direta /api/listings (sem Puppeteer)
    if (site.plataforma === "kenlo") {
      return await fetchKenloApi(url, site.nome, site.finalidade ?? "aluguel");
    }

    // ImovelWeb: Puppeteer com stealth
    if (site.plataforma === "imovelweb") {
      const html = await fetchComStealth(url, "[data-qa='posting PROPERTY']");
      if (!html) { console.warn(`  [!] ${site.nome}: sem resposta`); continue; }
      const encontrados = scrapeImovelWeb(html);
      console.log(`  ${site.nome}: ${encontrados.length} imóvel(is) encontrado(s)`);
      if (encontrados.length > 0) return encontrados;
      continue;
    }

    const html = (site.plataforma === "mn-imoveis" || site.plataforma === "silvana")
      ? await fetchPaginaComJs(url)
      : await fetchPagina(url);

    if (!html) {
      console.warn(`  [!] ${site.nome}: sem resposta`);
      continue;
    }

    let encontrados: Imovel[];
    if (site.plataforma === "imobibrasil") {
      encontrados = scrapeImobiBrasil(html, url, site.nome);
    } else if (site.plataforma === "mn-imoveis") {
      encontrados = scrapeMnImoveis(html, url);
    } else if (site.plataforma === "silvana") {
      encontrados = scrapeSilvanaCarvalho(html);
    } else {
      encontrados = scrapeGenerico(html, url, site.nome);
    }

    console.log(`  ${site.nome}: ${encontrados.length} imóvel(is) encontrado(s)`);
    if (encontrados.length > 0) return encontrados;
  }

  return [];
}

// ─── Estado ──────────────────────────────────────────────────────────────────
const ESTADO_PATH = path.join(process.cwd(), "estado.json");

function carregarEstado(): Estado {
  try {
    if (fs.existsSync(ESTADO_PATH)) {
      return JSON.parse(fs.readFileSync(ESTADO_PATH, "utf-8")) as Estado;
    }
  } catch {}
  return { vistos: [], ultimaRodada: "" };
}

function salvarEstado(estado: Estado): void {
  fs.writeFileSync(ESTADO_PATH, JSON.stringify(estado, null, 2), "utf-8");
}

// ─── Relatório .md ────────────────────────────────────────────────────────────
function renderizarSecao(lista: Imovel[], tipoPreco: "aluguel" | "venda"): string {
  let md = "";
  const porSite: Record<string, Imovel[]> = {};
  for (const im of lista) {
    if (!porSite[im.site]) porSite[im.site] = [];
    porSite[im.site].push(im);
  }
  for (const [site, imoveis] of Object.entries(porSite)) {
    md += `## ${site} (${imoveis.length})\n\n`;
    for (const im of imoveis) {
      const precoFmt = im.preco.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
      md += `### ${im.titulo}\n`;
      md += `- **Preço:** ${precoFmt}${tipoPreco === "aluguel" ? "/mês" : ""}\n`;
      md += `- **Quartos:** ${im.quartos}\n`;
      if (im.area > 0) md += `- **Terreno:** ${im.area} m²\n`;
      md += `- **Endereço:** ${im.endereco}\n`;
      md += `- **Link:** ${im.url}\n\n`;
    }
  }
  return md;
}

function gerarRelatorio(novosAluguel: Imovel[], novosVenda: Imovel[], data: string): string {
  const dataBR = data.split("-").reverse().join("/");

  let md = `# Imóveis em Itu — ${dataBR}\n\n`;

  // ── Seção Aluguel ──
  md += `---\n\n# 🏠 Casas para Aluguel\n\n`;
  md += `**Filtros:** ${QUARTOS_MIN}+ quartos · R$${PRECO_MIN.toLocaleString("pt-BR")} – R$${PRECO_MAX.toLocaleString("pt-BR")}/mês\n\n`;
  if (novosAluguel.length === 0) {
    md += `**Nenhuma casa nova para aluguel encontrada hoje.**\n\n`;
  } else {
    md += `**${novosAluguel.length} casa(s) nova(s) para aluguel**\n\n`;
    md += renderizarSecao(novosAluguel, "aluguel");
  }

  // ── Seção Venda ──
  md += `---\n\n# 🏡 Casas para Venda\n\n`;
  md += `**Filtros:** R$${VENDA_PRECO_MIN.toLocaleString("pt-BR")} – R$${VENDA_PRECO_MAX.toLocaleString("pt-BR")} · terreno ${VENDA_TERRENO_MIN}+ m²\n\n`;
  if (novosVenda.length === 0) {
    md += `**Nenhuma casa nova para venda encontrada hoje.**\n\n`;
  } else {
    md += `**${novosVenda.length} casa(s) nova(s) para venda**\n\n`;
    md += renderizarSecao(novosVenda, "venda");
  }

  return md;
}

// ─── Debug: salva HTML renderizado para inspeção ──────────────────────────────
const DEBUG = process.argv.includes("--debug");
const DEBUG_NETWORK = process.argv.includes("--debug-network");

async function debugSite(site: SiteConfig) {
  const url = site.urlsBusca[0];
  console.log(`\n[DEBUG] ${site.nome} → ${url}`);
  const usaBrowser = site.plataforma !== "imobibrasil" && site.plataforma !== "generica";
  const html = usaBrowser ? await fetchPaginaComJs(url) : await fetchPagina(url);
  if (!html) { console.log("[DEBUG] Sem resposta"); return; }

  const pasta = path.join(process.cwd(), "debug");
  if (!fs.existsSync(pasta)) fs.mkdirSync(pasta);
  const arquivo = path.join(pasta, `${site.nome.replace(/\s+/g, "-").toLowerCase()}.html`);
  fs.writeFileSync(arquivo, html, "utf-8");
  console.log(`[DEBUG] HTML salvo → debug/${path.basename(arquivo)} (${Math.round(html.length / 1024)}kb)`);
}

async function debugRede(site: SiteConfig) {
  const url = site.urlsBusca[0];
  console.log(`\n[REDE] ${site.nome} → ${url}`);

  const puppeteer = await import("puppeteer");
  const browser = await puppeteer.default.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
  });

  const chamadas: { url: string; status: number; tipo: string; corpo: string }[] = [];

  try {
    const page = await browser.newPage();
    await page.setUserAgent(HEADERS["User-Agent"]);

    page.on("response", async (response) => {
      const rUrl = response.url();
      const tipo = response.headers()["content-type"] ?? "";
      // Captura apenas respostas JSON ou texto (ignora imagens, CSS, fontes)
      if (!tipo.includes("json") && !tipo.includes("text/plain") && !tipo.includes("javascript")) return;
      try {
        const corpo = await response.text();
        // Só salva se parecer dado de imóveis (contém palavras-chave comuns)
        const relevante = corpo.includes("imovel") || corpo.includes("listing") || corpo.includes("preco") ||
                          corpo.includes("valor") || corpo.includes("aluguel") || corpo.includes("dormitorio") ||
                          corpo.includes("quarto") || corpo.includes("locacao");
        if (relevante || tipo.includes("json")) {
          chamadas.push({ url: rUrl, status: response.status(), tipo, corpo: corpo.slice(0, 5000) });
        }
      } catch {}
    });

    await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });
    // Aguarda mais 5s para carregar dados assíncronos
    await new Promise((resolve) => setTimeout(resolve, 5000));
  } finally {
    await browser.close();
  }

  const pasta = path.join(process.cwd(), "debug");
  if (!fs.existsSync(pasta)) fs.mkdirSync(pasta);
  const arquivo = path.join(pasta, `rede-${site.nome.replace(/\s+/g, "-").toLowerCase()}.json`);
  fs.writeFileSync(arquivo, JSON.stringify(chamadas, null, 2), "utf-8");

  console.log(`[REDE] ${chamadas.length} chamada(s) capturada(s) → debug/${path.basename(arquivo)}`);
  for (const c of chamadas) {
    console.log(`  [${c.status}] ${c.tipo.split(";")[0].padEnd(25)} ${c.url}`);
  }
}

// ─── CallMeBot (WhatsApp) ─────────────────────────────────────────────────────
function lerEnvConfig(): { phone: string; apikey: string } | null {
  // Prioridade 1: variáveis de ambiente (GitHub Actions / sistema)
  if (process.env.CALLMEBOT_PHONE && process.env.CALLMEBOT_APIKEY) {
    return { phone: process.env.CALLMEBOT_PHONE, apikey: process.env.CALLMEBOT_APIKEY };
  }
  // Prioridade 2: arquivo .env local
  try {
    const envPath = path.join(process.cwd(), ".env");
    if (!fs.existsSync(envPath)) return null;
    const linhas = fs.readFileSync(envPath, "utf-8").split("\n");
    const cfg: Record<string, string> = {};
    for (const linha of linhas) {
      const m = linha.match(/^\s*(\w+)\s*=\s*(.+)\s*$/);
      if (m) cfg[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
    }
    if (cfg.CALLMEBOT_PHONE && cfg.CALLMEBOT_APIKEY) {
      return { phone: cfg.CALLMEBOT_PHONE, apikey: cfg.CALLMEBOT_APIKEY };
    }
  } catch {}
  return null;
}

async function enviarWhatsApp(phone: string, apikey: string, mensagem: string): Promise<void> {
  const texto = encodeURIComponent(mensagem);
  const url = `https://api.callmebot.com/whatsapp.php?phone=${phone}&text=${texto}&apikey=${apikey}`;
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (resp.ok) {
      console.log("  WhatsApp enviado via CallMeBot.");
    } else {
      console.warn(`  [!] CallMeBot retornou status ${resp.status}`);
    }
  } catch (e) {
    console.warn(`  [!] Falha ao enviar WhatsApp: ${e}`);
  }
}

function montarMensagemWhatsApp(novosAluguel: Imovel[], novosVenda: Imovel[], hoje: string): string {
  const dataBR = hoje.split("-").reverse().join("/");
  const linhas: string[] = [`🏘️ WAT Imóveis Itu — ${dataBR}`];

  linhas.push(`\n🏠 Aluguel: ${novosAluguel.length} novo(s)`);
  if (novosAluguel.length > 0) {
    for (const im of novosAluguel.slice(0, 5)) {
      const preco = im.preco.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
      linhas.push(`  • ${im.titulo.slice(0, 40)} — ${preco}/mês`);
      linhas.push(`    ${im.url}`);
    }
    if (novosAluguel.length > 5) linhas.push(`  ... e mais ${novosAluguel.length - 5}`);
  }

  linhas.push(`\n🏡 Venda: ${novosVenda.length} novo(s)`);
  if (novosVenda.length > 0) {
    for (const im of novosVenda.slice(0, 5)) {
      const preco = im.preco.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
      linhas.push(`  • ${im.titulo.slice(0, 40)} — ${preco}`);
      linhas.push(`    ${im.url}`);
    }
    if (novosVenda.length > 5) linhas.push(`  ... e mais ${novosVenda.length - 5}`);
  }

  if (novosAluguel.length === 0 && novosVenda.length === 0) {
    linhas.push("\nNenhuma novidade hoje.");
  }

  return linhas.join("\n");
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  if (DEBUG) {
    console.log("\n=== MODO DEBUG: salvando HTML de cada site ===");
    for (const site of SITES) await debugSite(site);
    console.log("\nAbra os arquivos em debug/ para inspecionar o HTML de cada site.");
    return;
  }

  if (DEBUG_NETWORK) {
    const kenloSites = SITES.filter((s) => s.plataforma === "kenlo");
    console.log(`\n=== MODO DEBUG-NETWORK: interceptando requisições de ${kenloSites.length} site(s) Kenlo ===`);
    for (const site of kenloSites) await debugRede(site);
    console.log("\nInspecione os arquivos em debug/rede-*.json para ver as chamadas de API.");
    return;
  }

  const hoje = new Date().toISOString().split("T")[0];
  console.log(`\nBuscando casas em Itu — ${hoje}`);
  console.log(`Aluguel: ${QUARTOS_MIN}+ quartos · R$${PRECO_MIN}–R$${PRECO_MAX}/mês`);
  console.log(`Venda:   R$${VENDA_PRECO_MIN.toLocaleString("pt-BR")}–R$${VENDA_PRECO_MAX.toLocaleString("pt-BR")} · terreno ${VENDA_TERRENO_MIN}+ m²\n`);

  const estado = carregarEstado();
  const vistosSet = new Set(estado.vistos);

  // ── Aluguel ──────────────────────────────────────────────────────────────────
  const staticAluguel  = SITES.filter((s) => s.plataforma === "imobibrasil" || s.plataforma === "generica" || s.plataforma === "kenlo");
  const browserAluguel = SITES.filter((s) => s.plataforma === "mn-imoveis" || s.plataforma === "silvana" || s.plataforma === "imovelweb");

  console.log(`--- Aluguel: sites estáticos (${staticAluguel.length}) ---`);
  const resEstAluguel = await Promise.all(staticAluguel.map(raspaSite));

  console.log(`\n--- Aluguel: sites com JavaScript (${browserAluguel.length}) ---`);
  const resJsAluguel: Imovel[][] = [];
  for (const site of browserAluguel) resJsAluguel.push(await raspaSite(site));

  const todosAluguel = [...resEstAluguel.flat(), ...resJsAluguel.flat()].filter(
    (im) => im.preco >= PRECO_MIN && im.preco <= PRECO_MAX && im.quartos >= QUARTOS_MIN
  );
  console.log(`\nAluguel total após filtros: ${todosAluguel.length}`);

  // ── Venda ─────────────────────────────────────────────────────────────────────
  const staticVenda  = SITES_VENDA.filter((s) => s.plataforma === "imobibrasil" || s.plataforma === "generica" || s.plataforma === "kenlo");
  const browserVenda = SITES_VENDA.filter((s) => s.plataforma === "mn-imoveis" || s.plataforma === "silvana" || s.plataforma === "imovelweb");

  console.log(`\n--- Venda: sites estáticos (${staticVenda.length}) ---`);
  const resEstVenda = await Promise.all(staticVenda.map(raspaSite));

  console.log(`\n--- Venda: sites com JavaScript (${browserVenda.length}) ---`);
  const resJsVenda: Imovel[][] = [];
  for (const site of browserVenda) resJsVenda.push(await raspaSite(site));

  const todosVenda = [...resEstVenda.flat(), ...resJsVenda.flat()].filter(
    (im) => im.preco >= VENDA_PRECO_MIN && im.preco <= VENDA_PRECO_MAX &&
            (im.area === 0 || im.area >= VENDA_TERRENO_MIN)  // inclui área não informada
  );
  console.log(`Venda total após filtros: ${todosVenda.length}`);

  // ── Novos (não vistos antes) ───────────────────────────────────────────────
  const novosAluguel = todosAluguel.filter((im) => !vistosSet.has(im.id));
  const novosVenda   = todosVenda.filter((im) => !vistosSet.has(im.id));
  console.log(`\nNovos aluguel: ${novosAluguel.length} · Novos venda: ${novosVenda.length}`);

  for (const im of [...novosAluguel, ...novosVenda]) estado.vistos.push(im.id);
  estado.ultimaRodada = hoje;
  salvarEstado(estado);

  const pasta = path.join(process.cwd(), "resultados");
  if (!fs.existsSync(pasta)) fs.mkdirSync(pasta, { recursive: true });

  const arquivoSaida = path.join(pasta, `${hoje}.md`);
  fs.writeFileSync(arquivoSaida, gerarRelatorio(novosAluguel, novosVenda, hoje), "utf-8");

  console.log(`\nRelatório salvo → resultados/${hoje}.md`);

  // ── WhatsApp via CallMeBot ────────────────────────────────────────────────
  const cfg = lerEnvConfig();
  if (cfg) {
    console.log("\nEnviando notificação WhatsApp...");
    const mensagem = montarMensagemWhatsApp(novosAluguel, novosVenda, hoje);
    await enviarWhatsApp(cfg.phone, cfg.apikey, mensagem);
  } else {
    console.log("\n[WhatsApp] Sem configuração (.env). Crie o arquivo .env para ativar notificações.");
  }
}

main().catch(console.error);
