// `task jdt:formatter-defaults`: JDT's own formatter defaults, read out of the
// org.eclipse.jdt.core the pinned redhat.java ships — the same jars
// `jdt/deps.sh` installs, for the same reason (RFC 0001 decision 26): the
// numbers that matter are the ones the server actually runs with.
//
// RFC 0007 §6.2 writes the Eclipse profile *complete*, defaults and all, so a
// future redhat.java changing a default cannot silently move a team's format.
// That means the defaults have to be committed, hence this dump. Regenerate it
// on every bump of the redhat.java minimum (RFC 0007 §9).
import java.util.Map;
import java.util.TreeMap;
import org.eclipse.jdt.core.formatter.DefaultCodeFormatterConstants;

public final class EclipseDefaults {
    public static void main(String[] args) {
        Map<String, String> m = new TreeMap<>(DefaultCodeFormatterConstants.getEclipseDefaultSettings());
        StringBuilder b = new StringBuilder("{\n");
        int i = 0;
        for (Map.Entry<String, String> e : m.entrySet()) {
            b.append("  ").append(quote(e.getKey())).append(": ").append(quote(e.getValue()));
            if (++i < m.size()) b.append(',');
            b.append('\n');
        }
        System.out.print(b.append("}\n"));
    }

    // The keys and values are formatter option ids and enum names; no quoting
    // case has ever arisen, but a dump that produced invalid JSON on the day
    // one did would be found late and far from here.
    private static String quote(String s) {
        StringBuilder b = new StringBuilder("\"");
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c == '"' || c == '\\') b.append('\\').append(c);
            else if (c < 0x20) b.append(String.format("\\u%04x", (int) c));
            else b.append(c);
        }
        return b.append('"').toString();
    }
}
