// Import necessary modules
import axios from 'axios';
import { redis } from '@/lib/rediscache';
import { NextResponse } from "next/server";
import { ANIME } from "@consumet/extensions";
import { CombineEpisodeMeta } from '@/utils/EpisodeFunctions';
import { getMappings } from "./mappings";

// Axios request interceptor to set timeout
axios.interceptors.request.use(config => {
  config.timeout = 9000;
  return config;
});

// Initialize anime instances
const gogo = new ANIME.Gogoanime();
const zoro = new ANIME.Zoro();

// Fetch episodes from Consumet service
async function fetchConsumet(id) {
  try {
    async function fetchData(dub) {
      const { data } = await axios.get(
        `${process.env.CONSUMET_URI}/meta/anilist/episodes/${id}${dub ? "?dub=true" : ""}`
      );
      if (data?.message === "Anime not found" && data?.length < 1) {
        return [];
      }
      return data;
    }
    const [subData, dubData] = await Promise.all([
      fetchData(),
      fetchData(true),
    ]);

    return [{
      consumet: true,
      providerId: "gogoanime",
      episodes: {
        ...(subData && subData.length > 0 && { sub: subData }),
        ...(dubData && dubData.length > 0 && { dub: dubData }),
      },
    }];
  } catch (error) {
    console.error("Error fetching consumet:", error.message);
    return [];
  }
}

// Fetch episodes from Anify service
async function fetchAnify(id) {
  try {
    const { data } = await axios.get(`https://anify.eltik.cc/info/${id}?fields=[episodes]`);
    if (!data || !data?.episodes?.data) {
      return [];
    }
    const epdata = data?.episodes?.data;
    const filtereddata = epdata?.filter((episodes) => episodes.providerId !== "9anime");

    return filtereddata?.map(i => ({
      episodes: i.episodes,
      providerId: i.providerId === "gogoanime" ? "gogobackup" : i.providerId,
    }));
  } catch (error) {
    console.error("Error fetching anify:", error.message);
    return [];
  }
}

// Fetch episodes from Malsync
async function MalSync(id) {
  try {
    const response = await axios.get(`${process.env.MALSYNC_URI}${id}`);
    const data = response?.data;
    const sites = Object.keys(data.Sites).map(providerId => ({
      providerId: providerId.toLowerCase(),
      data: Object.values(data.Sites[providerId]),
    }));
    
    return sites.filter(site => site.providerId === 'gogoanime' || site.providerId === 'zoro');
  } catch (error) {
    console.error('Error fetching data from Malsync:', error);
    return null;
  }
}

// Fetch episodes from Gogoanime
async function fetchGogoanime(sub, dub) {
  try {
    const fetchData = async (id) => {
      const { data } = await axios.get(
        `${process.env.CONSUMET_URI}/anime/gogoanime/info/${id}`
      );
      if (data?.message === "Anime not found" && data?.episodes?.length < 1) {
        return [];
      }
      return data?.episodes;
    };

    const [subData, dubData] = await Promise.all([
      sub ? fetchData(sub) : Promise.resolve([]),
      dub ? fetchData(dub) : Promise.resolve([]),
    ]);

    return [{
      consumet: true,
      providerId: "gogoanime",
      episodes: {
        ...(subData && subData.length > 0 && { sub: subData }),
        ...(dubData && dubData.length > 0 && { dub: dubData }),
      },
    }];
  } catch (error) {
    console.error("Error fetching gogoanime:", error.message);
    return [];
  }
}

// Fetch episodes from Zoro
async function fetchZoro(id) {
  try {
    const { data } = await axios.get(`${process.env.ZORO_URI}/anime/episodes/${id}`);
    return data?.episodes ? [{ providerId: "zoro", episodes: data.episodes }] : [];
  } catch (error) {
    console.error("Error fetching zoro:", error.message);
    return [];
  }
}

// Fetch metadata for episodes
async function fetchEpisodeMeta(id, available = false) {
  try {
    if (available) {
      return null;
    }
    const { data } = await axios.get(`https://api.ani.zip/mappings?anilist_id=${id}`);
    return Object.values(data?.episodes) || [];
  } catch (error) {
    console.error("Error fetching and processing meta:", error.message);
    return [];
  }
}

// Fetch and cache episode data from multiple sources
const fetchAndCacheData = async (id, meta, redis, cacheTime, refresh) => {
  let malsync;
  if (id) {
    malsync = await MalSync(id);
  }

  const promises = [];
  if (malsync) {
    const gogoData = malsync.find(i => i.providerId === 'gogoanime');
    const zoroData = malsync.find(i => i.providerId === 'zoro');
    
    if (gogoData) {
      promises.push(fetchGogoanime(gogoData.sub, gogoData.dub));
    } else {
      promises.push(Promise.resolve([]));
    }
    
    if (zoroData) {
      promises.push(fetchZoro(zoroData.sub));
    } else {
      promises.push(Promise.resolve([]));
    }
    promises.push(fetchEpisodeMeta(id, !refresh));
  } else {
    promises.push(fetchConsumet(id));
    promises.push(fetchAnify(id));
    promises.push(fetchEpisodeMeta(id, !refresh));
  }
  
  const [consumet, anify, cover] = await Promise.all(promises);

  // Check if Redis is available
  if (redis) {
    const combinedData = [...consumet, ...anify];

    if (combinedData.length > 0) {
      await redis.setex(`episode:${id}`, cacheTime, JSON.stringify(combinedData));
    }

    let data = combinedData;
    if (refresh) {
      if (cover.length > 0) {
        try {
          await redis.setex(`meta:${id}`, cacheTime, JSON.stringify(cover));
          data = await CombineEpisodeMeta(combinedData, cover);
        } catch (error) {
          console.error("Error serializing cover:", error.message);
        }
      } else if (meta) {
        data = await CombineEpisodeMeta(combinedData, JSON.parse(meta));
      }
    } else if (meta) {
      data = await CombineEpisodeMeta(combinedData, JSON.parse(meta));
    }

    return data;
  } else {
    console.error("Redis URL not provided. Caching not possible.");
    return [...consumet, ...anify];
  }
};

// GET API endpoint
export const GET = async (req, { params }) => {
  const url = new URL(req.url);
  const id = params.animeid[0];
  const releasing = url.searchParams.get('releasing') === "true";
  const refresh = url.searchParams.get('refresh') === 'true';

  const cacheTime = releasing ? 60 * 60 * 3 : 60 * 60 * 24 * 45;

  let meta = null;
  let cached;

  if (redis) {
    try {
      meta = await redis.get(`meta:${id}`);
      if (JSON.parse(meta)?.length === 0) {
        await redis.del(`meta:${id}`);
        meta = null;
      }

      cached = await redis.get(`episode:${id}`);
      if (JSON.parse(cached)?.length === 0) {
        await redis.del(`episode:${id}`);
        cached = null;
      }

      if (refresh || !cached) {
        const data = await fetchAndCacheData(id, meta, redis, cacheTime, refresh);
        return NextResponse.json(data);
      }

    } catch (error) {
      console.error("Error checking Redis cache:", error.message);
    }
  }

  if (cached) {
    try {
      let cachedData = JSON.parse(cached);
      if (meta) {
        cachedData = await CombineEpisodeMeta(cachedData, JSON.parse(meta));
      }
      return NextResponse.json(cachedData);
    } catch (error) {
      console.error("Error parsing cached data:", error.message);
    }
  } else {
    const fetchdata = await fetchAndCacheData(id, meta, redis, cacheTime, !refresh);
    return NextResponse.json(fetchdata);
  }
};
