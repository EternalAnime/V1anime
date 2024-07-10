import axios from "axios";
import { redis } from "@/lib/rediscache";
import { NextResponse } from "next/server";

axios.interceptors.request.use(config => {
    config.timeout = 9000;
    return config;
})

async function fetchRecent() {
    try {
        const { data } = await axios.get(
            `https://api-mappings.madara.live/trending?api_key=eced54f4cd756c68abef8dcb5fdfe656fe120fce52965d88a00747d6a59c848b053eccf2caf026d86cc15163af940510d2ab05ca4ebaefed4e99c5b6bb4a3331&type=anime&page=1&perPage=20&fields=[id,title,status,format,currentEpisode,coverImage,episodes,totalEpisodes]`
        );

        const mappedData = data.map((i) => {
            const episodesData = i?.episodes?.data;
            const getEpisodes = episodesData ? episodesData.find((x) => x.providerId === "gogoanime") || episodesData[0] : [];
            const getEpisode = getEpisodes?.episodes?.find(
                (x) => x.number === i.currentEpisode
            );

            return {
                id: i.id,
                latestEpisode: getEpisode?.id ? getEpisode.id.substring(1) : '',
                title: i.title,
                status: i.status,
                format: i.format,
                totalEpisodes: i?.totalEpisodes,
                currentEpisode: i.currentEpisode,
                coverImage: i.coverImage,
            };
        });
        return mappedData;
    } catch (error) {
        console.error("Error fetching Recent Episodes:", error);
        return [];
    }
}

export const GET = async (req) => {
    let cached;
    if (redis) {
        console.log('using redis')
        cached = await redis.get('recent');
    }
    if (cached) {
        return NextResponse.json(JSON.parse(cached));
    }
    else {
        const data = await fetchRecent();
        if (data && data?.length > 0) {
            if (redis) {
                await redis.set(
                    "recent",
                    JSON.stringify(data),
                    "EX",
                    60 * 60
                );
            }
            return NextResponse.json(data);
        } else {
            return NextResponse.json({ message: "Recent Episodes not found" });
        }
    }
};