// Annotation storage. Everything else talks to this interface, so a shared
// backend can replace browser storage later without touching app.js:
//   list() -> Promise<Feature[]>, add(features), remove(ids), merge(features)

const Storage = (() => {
  const KEY = "tpos_annotations_v1";

  function read() {
    try {
      return JSON.parse(localStorage.getItem(KEY)) || [];
    } catch {
      return [];
    }
  }

  function write(features) {
    localStorage.setItem(KEY, JSON.stringify(features));
  }

  return {
    async list() {
      return read();
    },
    async add(features) {
      write(read().concat(features));
    },
    async remove(ids) {
      const drop = new Set(ids);
      write(read().filter(f => !drop.has(f.properties.annotation_id)));
    },
    // Adds features whose annotation_id is not already stored; returns the
    // number added.
    async merge(features) {
      const existing = read();
      const ids = new Set(existing.map(f => f.properties.annotation_id));
      const fresh = features.filter(f => f.properties && f.properties.annotation_id && !ids.has(f.properties.annotation_id));
      write(existing.concat(fresh));
      return fresh.length;
    }
  };
})();
