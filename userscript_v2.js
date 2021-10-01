// ==UserScript==
// @name        Netflix - Subtitles Manager
// @description Allows you to download subtitles from Netflix
// @license     MIT
// @version     1
// @namespace   github.com/aci2n
// @include     https://www.netflix.com/watch*
// ==/UserScript==

/*
Queue url builder:
(function() {
  const episodeIds = Array.from(document.querySelectorAll(".ptrack-content > a"))
    .map(link => link.href)
    .map(url => url.split('/').pop().split('?').shift())
    .map(id => Number.parseInt(id))
    .filter(id => !isNaN(id));
  return window.location.origin + '/watch/' + episodeIds[0] + '?mode=batch&first&langs=ja&format=WEBVTT&queue=' + episodeIds.slice(1).join(',');
}())
*/

const FORMATS = {
  WEBVTT: { id: 'webvtt', name: 'webvtt-lssdh-ios8', ext: 'vtt' },
  DFXP: { id: 'dfxp', name: 'dfxp-ls-sdh', ext: 'dfxp' },
  SIMPLESDH: { id: 'simplesdh', name: 'simplesdh', ext: 'xml' }
};

const MODE = {
  SINGLE: 'single',
  BATCH: 'batch',
  NONE: 'none'
}

class Config {
  static MODE_KEY = 'mode';
  static QUEUE_KEY = 'queue';
  static LANGS_KEY = 'langs';
  static FORMAT_KEY = 'format';
  static FIRST_KEY = 'first';

  static fromSearchString(searchString) {
    const params = new URLSearchParams(searchString);
    const mode = params.get(Config.MODE_KEY) || '';
    const queue = params.get(Config.QUEUE_KEY) || '';
    const langs = params.get(Config.LANGS_KEY) || '';
    const format = params.get(Config.FORMAT_KEY) || '';
    const first = params.has(Config.FIRST_KEY);
    return new Config(
      MODE[mode.toUpperCase()] || MODE.NONE,
      queue ? queue.split(',') : [],
      langs ? langs.split(',') : [],
      FORMATS[format.toUpperCase()] || FORMATS.WEBVTT,
      first);
  }

  constructor(mode, queue, langs, format, first) {
    this.mode = mode;
    this.queue = queue;
    this.langs = langs;
    this.format = format;
    this.first = first;
  }

  toSearchString() {
    const params = new URLSearchParams();
    params.set(Config.MODE_KEY, this.mode);
    params.set(Config.FORMAT_KEY, this.format.id);
    if (this.first) {
      params.set(Config.FIRST_KEY, '');
    }
    if (this.langs.length > 0) {
      params.set(Config.LANGS_KEY, this.langs.join(','));
    }
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
      video.seasons.forEach(season => console.log('Season', season.seq, season.episodes.map(episode => episode.seq)));

      if (video.currentEpisode == null) {
        throw new Error('Current episode missing');
      }

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

      if (episodes.length === 0) {
        throw new Error('Got empty list of episodes');
      }

      const index = episodes.findIndex(episode => episode.id === video.currentEpisode);

      if (index === -1) {
        throw new Error('Did not find current episode in metadata');
      }

      const first = episodes[0];
      const current = episodes[index];
      const next = episodes[index + 1]; // nullable

      console.log('First episode', this.friendlyLogFormat(first));
      console.log('Current episode', this.friendlyLogFormat(current));
      if (next) {
        console.log('Next episode', this.friendlyLogFormat(next));
      } else {
        console.log('Last episode of this series');
      }

      return { first, current, next };
    }

    if (video.type === 'movie' || video.type === 'supplemental') {
      const current = { id: video.id, title: null, seq: null, show: video.title };
      console.log('Processed metadata for movie', current);
      return { first: current, current, next: null };
    }

    throw new Error('Unknown video type: ' + video.type);
  }

  friendlyLogFormat(episode) {
    return { season: episode.seq.season, ep: episode.seq.episode, title: episode.title, id: episode.id };
  }
}

class SubtitlesProcessor {
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
      const urlsByFormat = {};

      for (const format of Object.values(FORMATS)) {
        const downloadables = track.ttDownloadables[format.name];

        if (downloadables != null) {
          const urls = Object.values(downloadables.downloadUrls);

          if (urls.length > 0) {
            urlsByFormat[format.id] = urls;
          } else {
            console.warn('Found no download urls for a format in track', format, track);
          }
        }
      }

      if (Object.keys(urlsByFormat).length > 0) {
        subs.push({ lang, urlsByFormat });
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
      const urls = sub.urlsByFormat[config.format.id];

      if (urls) {
        const filename = this.getFilename(episode, sub.lang.tag, config.format.ext);
        console.log('Will try to download sub', urls, filename);
        downloads.push(await this.downloadFirst(urls, filename));
      } else {
        console.log('Format not found in sub', sub);
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
      const { metadata, config } = ctx;

      if (config.first) {
        console.log('Downloading first episode in show');
      }

      if (config.first && metadata.current.id !== metadata.first.id) {
        const url = this.buildUrl(metadata.first.id, config);
        console.warn('Expected the first episode in show but got another one, redirecting', url);
        location.href = url;
        return [];
      }

      const downloads = await new SingleFetcher().download(ctx);
      console.log('Download finished, will process next', downloads, metadata, config);

      if (metadata.next && downloads.length === 0) {
        console.warn('Did not download any subtitles for episode, will skip show', metadata, config);
      }

      if (metadata.next && downloads.length > 0) {
        const c = new Config(config.mode, config.queue, config.langs, config.format, false);
        const url = this.buildUrl(metadata.next.id, c);
        console.log('Advancing to next episode in show', url)
        location.href = url;
      } else if (config.queue.length > 0) {
        const c = new Config(config.mode, config.queue.slice(1), config.langs, config.format, true);
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
      return error;
    }
  }

  buildUrl(id, config) {
    return `${location.origin}/watch/${id}?${config.toSearchString()}`;
  }
}

class Initializer {
  async initialize() {
    try {
      const config = Config.fromSearchString(location.search);
      if (config.mode === MODE.NONE) {
        console.log('No mode defined, will not do anything');
        return null;
      }

      console.log('Waiting for necessary data to download subtitles...');
      const promise = Promise.race([
        new Promise((_, reject) => setTimeout(() => reject(new Error('Timed out waiting for data')), 30000)),
        Promise.all([new MetadataProcessor().get(), new SubtitlesProcessor().get()])
      ]);

      new Injector().inject();

      const [metadata, subs] = await promise;
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
      console.error('Something failed during initialization, will reload and retry', error);
      location.reload();
      return error;
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
                if (error instanceof TypeError) {
                  continue;
                } else {
                  throw error;
                }
              }
            }
          }
          return stringify(data);
        };

        XMLHttpRequest.prototype.open = function () {
          if (arguments[1] && arguments[1].includes('/metadata?')) {
            this.addEventListener('load', () => {
              dispatchEvent(new CustomEvent('metadata_loaded', { detail: this.response }));
            }, false);
          }
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