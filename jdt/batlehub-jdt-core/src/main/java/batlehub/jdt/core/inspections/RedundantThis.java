package batlehub.jdt.core.inspections;

import batlehub.jdt.core.Finding;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import org.eclipse.jdt.core.dom.ASTNode;
import org.eclipse.jdt.core.dom.ASTVisitor;
import org.eclipse.jdt.core.dom.Assignment;
import org.eclipse.jdt.core.dom.CompilationUnit;
import org.eclipse.jdt.core.dom.FieldAccess;
import org.eclipse.jdt.core.dom.LambdaExpression;
import org.eclipse.jdt.core.dom.MethodDeclaration;
import org.eclipse.jdt.core.dom.SingleVariableDeclaration;
import org.eclipse.jdt.core.dom.ThisExpression;
import org.eclipse.jdt.core.dom.VariableDeclarationFragment;

/** `this.x` where no parameter or local named `x` is in scope in the method. */
public final class RedundantThis extends Base {
  public RedundantThis() {
    super("style", "redundantThis", "info");
  }

  @Override
  public void visit(CompilationUnit cu, List<Finding> out) {
    cu.accept(new ASTVisitor() {
      @Override
      public boolean visit(MethodDeclaration m) {
        Set<String> locals = new HashSet<>();
        m.accept(new ASTVisitor() {
          @Override
          public boolean visit(SingleVariableDeclaration d) {
            locals.add(d.getName().getIdentifier());
            return true;
          }

          @Override
          public boolean visit(VariableDeclarationFragment d) {
            locals.add(d.getName().getIdentifier());
            return true;
          }

          @Override
          public boolean visit(LambdaExpression l) {
            return true;
          }
        });
        m.accept(new ASTVisitor() {
          @Override
          public boolean visit(FieldAccess fa) {
            if (!(fa.getExpression() instanceof ThisExpression te) || te.getQualifier() != null) return true;
            String name = fa.getName().getIdentifier();
            if (locals.contains(name)) return true;
            // `this.x = x` in a setter is the idiom; only flag when nothing shadows — which the local set already decided.
            ASTNode parent = fa.getParent();
            if (parent instanceof Assignment a && a.getLeftHandSide() == fa && locals.contains(name)) return true;
            out.add(new Finding(RedundantThis.this, fa, "'this.' is redundant: nothing shadows '" + name + "'", "Remove 'this.'",
                rw -> rw.replace(fa, rw.createCopyTarget(fa.getName()), null)));
            return true;
          }
        });
        return false;
      }
    });
  }
}
