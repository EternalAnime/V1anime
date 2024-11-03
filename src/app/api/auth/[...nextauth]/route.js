import NextAuth from "next-auth";
import { getServerSession } from "next-auth";

export const authOptions = {
  secret: process.env.NEXTAUTH_SECRET,
  providers: [
    {
      id: "AniListProvider",
      name: "AniList",
      type: "oauth",
      token: "https://anilist.co/api/v2/oauth/token",
      authorization: {
        url: "https://anilist.co/api/v2/oauth/authorize",
        params: { scope: "", response_type: "code" },
      },
      userinfo: {
        url: "https://graphql.anilist.co",
        async request(context) {
          const response = await fetch("https://graphql.anilist.co", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${context.tokens.access_token}`,
              Accept: "application/json",
            },
            body: JSON.stringify({
              query: `
                query {
                  Viewer {
                    id
                    name
                    avatar {
                      large
                      medium
                    }
                    bannerImage
                    createdAt
                    mediaListOptions {
                      animeList {
                        customLists
                      }
                    }
                  }
                }
              `,
            }),
          });
          const { data } = await response.json();

          const userLists = data?.Viewer?.mediaListOptions?.animeList?.customLists || [];

          if (!userLists.includes("Watched Via 1Anime")) {
            userLists.push("Watched Via 1Anime");
            const fetchGraphQL = async (query, variables) => {
              const res = await fetch("https://graphql.anilist.co/", {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  ...(context.tokens.access_token && {
                    Authorization: `Bearer ${context.tokens.access_token}`,
                  }),
                  Accept: "application/json",
                },
                body: JSON.stringify({ query, variables }),
              });
              return res.json();
            };

            const setListMutation = `
              mutation($lists: [String]) {
                UpdateUser(animeListOptions: { customLists: $lists }) {
                  id
                }
              }
            `;
            await fetchGraphQL(setListMutation, { lists: userLists });
          }

          return {
            token: context.tokens.access_token,
            name: data.Viewer.name,
            sub: data.Viewer.id,
            image: data.Viewer.avatar.large,
            createdAt: data.Viewer.createdAt,
            list: userLists,
          };
        },
      },
      clientId: process.env.ANILIST_CLIENT_ID,
      clientSecret: process.env.ANILIST_CLIENT_SECRET,
      profile(profile) {
        return {
          token: profile.token,
          id: profile.sub,
          name: profile.name,
          image: profile.image,
          createdAt: profile.createdAt,
          list: profile.list,
        };
      },
    },
  ],
  session: {
    strategy: "jwt",
  },
  callbacks: {
    async jwt({ token, user }) {
      return { ...token, ...user };
    },
    async session({ session, token }) {
      session.user = token;
      return session;
    },
  },
};

const handler = NextAuth(authOptions);

export const getAuthSession = () => getServerSession(authOptions);

export { handler as GET, handler as POST };
