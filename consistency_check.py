import pysubs2
import argparse
import os
import sys
import glob
import re
import pathlib


def main():
    args_parser = argparse.ArgumentParser()
    args_parser.add_argument('input_directory')
    args = args_parser.parse_args()

    if not os.path.isdir(args.input_directory):
        print(
            f'Not a valid directory: {args.input_directory}', file=sys.stderr)
        return

    output_directory = os.path.join(args.input_directory, 'out')
    print(f'Output directory: {output_directory}')

    glob_path = os.path.join(args.input_directory, '*.vtt')
    vtt_files = glob.glob(glob_path)
    print(f'Found {len(vtt_files)} with glob {glob_path}')

    season_re = re.compile('(.*)\.S(\d+)E(\d+)')

    shows = {}
    for vtt_file in vtt_files:
        basename = os.path.basename(vtt_file)
        match = season_re.match(basename)

        if match == None:
            continue

        show_title = match.group(1)
        season_seq = int(match.group(2))
        episode_seq = int(match.group(3))

        if show_title not in shows:
            shows[show_title] = {}

        if season_seq not in shows[show_title]:
            shows[show_title][season_seq] = []

        shows[show_title][season_seq].append(episode_seq)

    sorted_shows = []
    for show_title, seasons_map in shows.items():
        seasons_list = []
        for season_seq, episodes_list in seasons_map.items():
            sorted_episodes_list = sorted(set(episodes_list))
            seasons_list.append((season_seq, sorted_episodes_list))
        sorted_seasons_list = sorted(seasons_list, key=lambda a: a[0])
        sorted_shows.append((show_title, sorted_seasons_list))

    for sorted_show in sorted_shows:
        [show_title, sorted_seasons_list] = sorted_show
        expected_season_seq = 1
        expected_episode_seq = 1

        for sorted_season in sorted_seasons_list:
            [season_seq, sorted_episodes_list] = sorted_season
            offset = expected_episode_seq - 1 if sorted_episodes_list[0] == 1 else 0

            if season_seq != expected_season_seq:
                print(f"{show_title}: expected season {expected_season_seq}, got {season_seq}")

            for episode_seq in sorted_episodes_list:
                offseted_seq = episode_seq + offset
                if offseted_seq != expected_episode_seq:
                    print(f"{show_title} (S{season_seq}): expected episode {expected_episode_seq}, got {offseted_seq}")
                expected_episode_seq += 1
            
            expected_season_seq +=1

main()
