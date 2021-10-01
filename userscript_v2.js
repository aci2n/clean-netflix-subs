// ==UserScript==
// @name        Netflix - Subtitles Manager
// @description Allows you to download subtitles from Netflix
// @license     MIT
// @version     1
// @namespace   github.com/aci2n
// @include     https://www.netflix.com/watch*
// ==/UserScript==

const FORMATS = {
  WEBVTT: { id: 'WEBVTT', name: 'webvtt-lssdh-ios8', ext: 'vtt' },
  DFXP: { id: 'DFXP', name: 'dfxp-ls-sdh', ext: 'dfxp' },
  SIMPLESDH: { id: 'SIMPLESHD', name: 'simplesdh', ext: 'xml' }
};

const MODE = {
  SINGLE: 'single',
  BATCH: 'batch',
  NONE: 'none'
}

class Config {
  static LANGS_KEY = 'langs';
  static MODE_KEY = 'mode';
  static QUEUE_KEY = 'queue';
  static FORMAT_KEY = 'format';

  static fromSearchString(searchString) {
    const params = new URLSearchParams(searchString);
    return new Config(
      params.get(Config.MODE_KEY) || MODE.NONE,
      Config.readAsArray(params.get(Config.QUEUE_KEY)),
      Config.readAsArray(params.get(Config.LANGS_KEY)),
      FORMATS[params.get(Config.FORMAT_KEY)] || FORMATS.WEBVTT);
  }

  constructor(mode, queue, langs, format) {
    this.mode = mode;
    this.queue = queue;
    this.langs = langs;
    this.format = format;
  }

  static readAsArray(value) {
    return value ? value.split(',') : [];
  }

  toSearchString() {
    const params = new URLSearchParams();
    params.set(Config.MODE_KEY, this.mode);
    if (this.langs.length > 0) {
      params.set(Config.LANGS_KEY, this.langs.join(','));
    }
    params.set(Config.FORMAT_KEY, this.format.id);
    if (this.queue.length > 0) {
      params.set(Config.QUEUE_KEY, this.queue.join(','));
    }
    return params.toString();
  }
}

class MetadataProcessor {
  async get() {
    const data = await new Promise(resolve => addEventListener('metadata_loaded', event => resolve(event.detail)));
    console.log('Raw metadata', data);
    const video = data.video;

    if (video.type === 'show') {
      if (video.currentEpisode == null) {
        throw new Error('Current episode missing');
      }
      video.seasons.forEach(season => console.log('Season', season.seq, season.episodes.map(episode => episode.seq)));

      const episodes = video.seasons.flatMap(season => season.episodes.map(episode => {
        return {
          id: episode.id,
          title: episode.title,
          seq: { season: season.seq, episode: episode.seq },
          show: video.title
        };
      })).sort((a, b) => {
        if (a.seq.season != b.seq.season) {
          return a.seq.season - b.seq.season;
        }
        return a.seq.episode - b.seq.episode;
      });
      const index = episodes.findIndex(episode => episode.id === video.currentEpisode);

      if (index === -1) {
        throw new Error('Did not find current episode in metadata');
      }

      const current = episodes[index];
      const next = episodes[index + 1]; // nullable

      console.log('Current episode', { season: current.seq.season, ep: current.seq.episode, title: current.title, id: current.id });
      if (next) {
        console.log('Next episode', { season: next.seq.season, ep: next.seq.episode, title: next.title, id: next.id });
      } else {
        console.log('Last episode of this series');
      }

      return { current, next };
    }

    if (video.type === 'movie' || video.type === 'supplemental') {
      const current = { id: video.id, title: null, seq: null, show: video.title };
      console.log('Processed metadata for movie', current);
      return { current, next: null };
    }

    throw new Error('Unknown video type: ' + video.type);
  }
}

class SubtitlesProcessor {
  static SUB_TYPES = {
    'subtitles': '',
    'closedcaptions': '[cc]'
  };

  async get() {
    const data = await new Promise(resolve => addEventListener('subtitles_loaded', event => resolve(event.detail)));
    console.log('Raw subtitles', data);
    const subs = [];

    for (const track of data.timedtexttracks) {
      if (track.isNoneTrack) {
        continue;
      }

      const type = this.getType(track.rawTrackType);
      const lang = {
        id: track.language,
        tag: track.language + type + (track.isForcedNarrative ? '-forced' : ''),
      };
      const formats = {};

      for (const format of Object.values(FORMATS)) {
        const downloadables = track.ttDownloadables[format.name];

        if (downloadables != null) {
          const downloadUrls = Object.values(downloadables.downloadUrls);

          if (downloadUrls.length > 0) {
            formats[format.id] = { downloadUrls };
          } else {
            console.warn('Found no download urls for a format in track', format, track);
          }
        }
      }

      if (Object.keys(formats).length > 0) {
        subs.push({ lang, formats });
      } else {
        console.log('Did not find any downloadables for track', track);
      }
    }

    console.log('Finished processing subtitles', subs.map(sub => sub.lang.tag));
    return subs;
  }

  getType(rawType) {
    if (rawType == null || rawType === 'subtitles') {
      return '';
    }
    if (rawType === 'closedcaptions') {
      return '[cc]';
    }
    return `[${rawType}]`;
  }
}

class SingleFetcher {
  async download(ctx) {
    const { subs, metadata, config } = ctx;
    const langs = new Set(config.langs);
    const filtered = langs.length === 0 ? subs : subs.filter(sub => langs.has(sub.lang.id));
    const episode = metadata.current;
    const downloads = [];
    console.log('Starting fetch', config, langs, filtered, episode);

    if (filtered.length === 0) {
      console.warn('No languages found for downloading', langs, subs.map(sub => sub.lang.tag));
    }

    for (const sub of filtered) {
      const format = sub.formats[config.format.id];

      if (format) {
        const filename = this.getFilename(episode, sub.lang.tag, config.format.ext);
        console.log('Will try to download sub', format.downloadUrls, filename);
        downloads.push(await this.downloadFirst(format.downloadUrls, filename));
      } else {
        console.log('Format not found in sub', format, sub);
      }
    }

    console.log('Done downloading', downloads.length);
    return downloads;
  }

  async downloadFirst(urls, filename) {
    for (const url of urls) {
      try {
        console.log('Downloading from url', url);
        return await this.downloadSingle(url, filename);
      } catch (error) {
        console.error('Could not download from url, will try other urls if remaining', url, error);
      }
    }
    throw new Error('All urls failed to download');
  }

  async downloadSingle(url, filename) {
    const result = await fetch(url, { mode: 'cors' });
    const blob = await result.blob();

    if (blob.size == 0) {
      throw new Error('Empty blob from download');
    }

    console.log('Download successful', blob);
    this.save(blob, filename);
    return blob;
  }

  save(blob, filename) {
    const link = document.createElement("a");
    const url = URL.createObjectURL(blob);

    link.style = "display: none";
    document.body.appendChild(link);
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
    document.body.removeChild(link);
  }

  getFilename(episode, lang, ext) {
    const { id, show, title, seq } = episode;
    const tokens = [show];
    if (seq) {
      tokens.push(`S${this.padSeq(seq.season)}E${this.padSeq(seq.episode)}`);
    }
    if (title) {
      tokens.push(title);
    }
    tokens.push(id, 'WEBRip', 'Netflix', lang, ext);
    return tokens.join('.');
  }

  padSeq(seq) {
    return seq.toString().padStart(2, '0');
  }
}

class BatchFetcher {
  async download(ctx) {
    try {
      const downloads = await new SingleFetcher().download(ctx);
      const { metadata, config } = ctx;

      console.log('Download finished, will process next', downloads, metadata, config);

      if (metadata.next && downloads.length === 0) {
        console.warn('Did not download any subtitles for episode, will skip series', metadata, config);
      }

      if (metadata.next && downloads.length > 0) {
        const url = this.buildUrl(metadata.next.id, config);
        console.log('Advancing to next episode in show', url)
        location.href = url;
      } else if (config.queue.length > 0) {
        const c = new Config(config.mode, config.queue.slice(1), config.langs, config.format);
        const url = this.buildUrl(config.queue[0], c);
        console.log('Advacing to next queued show', url);
        location.href = url;
      } else {
        console.log('Batch finished, returning to homepage');
        location.href = location.origin;
      }

      return downloads;
    } catch (error) {
      console.error('Something failed during fetch, will reload and retry', error);
      location.reload();
      throw error;
    }
  }

  buildUrl(id, config) {
    return `${location.origin}/watch/${id}?${config.toSearchString()}`;
  }
}

class Initializer {
  async initialize() {
    try {
      const promise = Promise.race([
        new Promise((_, reject) => setTimeout(() => reject(new Error('Timed out waiting for data')), 30000)),
        Promise.all([new MetadataProcessor().get(), new SubtitlesProcessor().get()])
      ]);
      new Injector().inject();

      const [metadata, subs] = await promise;
      const config = Config.fromSearchString(location.search);
      const ctx = { metadata, subs, config };

      switch (config.mode) {
        case MODE.SINGLE:
          console.log('Downloading single');
          new SingleFetcher().download(ctx);
          break;
        case MODE.BATCH:
          console.log('Downloading batch', config.queue);
          new BatchFetcher().download(ctx);
          break;
      }

      return ctx;
    } catch (error) {
      console.log('Something failed during initialization, will reload and retry', error);
      location.reload();
      throw error;
    }
  }
}

class Injector {
  inject() {
    const injection = () => {
      const manifestPattern = new RegExp('manifest|licensedManifest');
      const webvtt = 'webvtt-lssdh-ios8';

      ((parse, stringify, open) => {
        JSON.parse = function (text) {
          const data = parse(text);
          if (data && data.result && data.result.timedtexttracks && data.result.movieId) {
            dispatchEvent(new CustomEvent('subtitles_loaded', { detail: data.result }));
          }
          return data;
        };

        JSON.stringify = function (data) {
          if (data && typeof data.url === 'string' && data.url.search(manifestPattern) > -1) {
            for (const value of Object.values(data)) {
              try {
                if (value.profiles) {
                  value.profiles.unshift(webvtt);
                }
                value.showAllSubDubTracks = true;
              }
              catch (error) {
                if (error instanceof TypeError)
                  continue;
                else
                  throw error;
              }
            }
          }
          return stringify(data);
        };

        XMLHttpRequest.prototype.open = function () {
          if (arguments[1] && arguments[1].includes('/metadata?'))
            this.addEventListener('load', () => {
              dispatchEvent(new CustomEvent('metadata_loaded', { detail: this.response }));
            }, false);
          open.apply(this, arguments);
        };
      })(JSON.parse, JSON.stringify, XMLHttpRequest.prototype.open);
    }

    const script = document.createElement('script');
    script.innerHTML = '(' + injection.toString() + ')()';
    document.head.appendChild(script);
    document.head.removeChild(script);
  }
}

new Initializer().initialize();