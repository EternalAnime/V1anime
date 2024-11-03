import axios from 'axios';
import { redis } from '@/lib/rediscache';
import { NextResponse } from "next/server";
import { CombineEpisodeMeta } from '@/utils/EpisodeFunctions';

axios.interceptors.request.use(config => {
  config.timeout = 9000; // Set a timeout for all axios requests
  return config;
});

// Fetch episode data from Consumet API, both sub and dub
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
      fetchData(false), // Fetch sub data
      fetchData(true),  // Fetch dub data
    ]);

    const array = [
      {
        consumet: true,
        providerId: "consumet",
        episodes: {
          ...(subData && subData.length > 0 && { sub: subData }),
          ...(dubData && dubData.length > 0 && { dub: dubData }),
        },
      },
    ];

    return array;
  } catch (error) {
    console.error("Error fetching consumet:", error.message);
    return [];
  }
}

// Fetch Gogoanime episodes
async function fetchGogoanime(sub, dub) {
  try {
    async function fetchData(id) {
      const { data } = await axios.get(
        `${process.env.CONSUMET_URI}/anime/gogoanime/info/${id}`
      );
      if (data?.message === "Anime not found" && data?.episodes?.length < 1) {
        return [];
      }
      return data?.episodes;
    }

    const promises = [];
    if (sub !== "") promises.push(fetchData(sub));
    if (dub !== "") promises.push(fetchData(dub));

    const [subData, dubData] = await Promise.all(promises);

    const array = [
      {
        consumet: true,
        providerId: "gogoanime",
        episodes: {
          ...(subData && subData.length > 0 && { sub: subData }),
          ...(dubData && dubData.length > 0 && { dub: dubData }),
        },
      },
    ];

    return array;
  } catch (error) {
    console.error("Error fetching consumet gogoanime:", error.message);
    return [];
  }
}

// Fetch episodes from Zoro
async function fetchZoro(id) {
  try {
    const { data } = await axios.get(`${process.env.ZORO_URI}/anime/episodes/${id}`);
    if (!data?.episodes) return [];

    const array = [
      {
        providerId: "zoro",
        episodes: data?.episodes,
      },
    ];

    return array;
  } catch (error) {
    console.error("Error fetching zoro:", error.message);
    return [];
  }
}

// Fetch episode metadata
async function fetchEpisodeMeta(id, available = false) {
  try {
    if (available) {
      return null;
    }
    const { data } = await axios.get(`https://api.ani.zip/mappings?anilist_id=${id}`);
    const episodesArray = Object.values(data?.data?.episodes);

    if (!episodesArray) {
      return [];
    }
    return episodesArray;
  } catch (error) {
    console.error("Error fetching and processing meta:", error.message);
    return [];
  }
}

// Main function to fetch and cache data
const fetchAndCacheData = async (id, meta, redis, cacheTime, refresh) => {
  let malsync;
  if (id) {
    malsync = await MalSync(id); // Assuming MalSync function is also defined correctly to fetch mappings
  }
  const promises = [];
  
  if (malsync) {
    const gogop = malsync.find((i) => i.providerId === 'gogoanime');
    const zorop = malsync.find((i) => i.providerId === 'zoro');
  
    if (gogop) {
      promises.push(fetchGogoanime(gogop.sub, gogop.dub));
    } else {
      promises.push(Promise.resolve([]));
    }
  
    if (zorop) {
      promises.push(fetchZoro(zorop.sub));
    } else {
      promises.push(Promise.resolve([]));
    }
    promises.push(fetchEpisodeMeta(id, !refresh));
  } else {
    promises.push(fetchConsumet(id)); // this already fetches both sub and dub
    promises.push(fetchAnify(id)); // Assuming this function is defined to fetch from Anify
    promises.push(fetchEpisodeMeta(id, !refresh));
  }

  const [consumet, anify, cover] = await Promise.all(promises);  

  // Check if redis is available
  if (redis) {
    if (consumet.length > 0 || anify.length > 0) {
      await redis.setex(`episode:${id}`, cacheTime, JSON.stringify([...consumet, ...anify]));
    }

    const combinedData = [...consumet, ...anify];
    let data = combinedData;
    if (refresh) {
      if (cover && cover?.length > 0) {
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

// Main GET handler
export const GET = async (req, { params }) => {
  const url = new URL(req.url);
  const id = params.animeid[0];
  const releasing = url.searchParams.get('releasing') || false;
  const refresh = url.searchParams.get('refresh') === 'true' || false;

  let cacheTime = null;
  if (releasing === "true") {
    cacheTime = 60 * 60 * 3;
  } else if (releasing === "false") {
    cacheTime = 60 * 60 * 24 * 45;
  }

  let meta = null;
  let cached;

  if (redis) {
    try {
      meta = await redis.get(`meta:${id}`);
      if (JSON.parse(meta)?.length === 0) {
        await redis.del(`meta:${id}`);
        console.log("deleted meta cache");
        meta = null;
      }
      cached = await redis.get(`episode:${id}`);
      if (JSON.parse(cached)?.length === 0) {
        await redis.del(`episode:${id}`);
        cached = null;
      }
      let data;
      if (refresh) {
        data = await fetchAndCacheData(id, meta, redis, cacheTime, refresh);
      }
      if (data?.length > 0) {
        console.log("deleted cache");
        return NextResponse.json(data);
      }

      console.log("using redis");
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
